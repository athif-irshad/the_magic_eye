// standard modules
require('dotenv').config();
const outdent = require('outdent');
const chalk = require('chalk');
const log = require('loglevel');
const indentString = require('indent-string');
const Validator = require('jsonschema').Validator;
log.setLevel(process.env.LOG_LEVEL ? process.env.LOG_LEVEL : 'info');
const { getSubredditSettings, setSubredditSettings, getMasterProperty, setMasterProperty } = require('./mongodb_master_data.js');


async function createDefaultSettings(subredditName, masterSettings, reddit) {
    log.info('Creating default settings for', subredditName, '...');
    const wikiPage = await reddit.getSubreddit(subredditName).getWikiPage('magic_eye');

    try {
        const settings = JSON.parse(await wikiPage.content_md);
        if (settings) {
            log.info(chalk.magenta('Wiki settings already exist when trying to create defaults. Ignoring and using existing settings for '), subredditName);
            masterSettings.settings = settings;
            return;
        }
    } catch (e) {
        log.info('Creating new settings mode.');
    }

    const stringSettings = JSON.stringify(masterSettings.settings, null, 4);
    const indentedSettings = indentString(stringSettings, 4);
    await wikiPage.edit({text: indentedSettings, reason: 'Create default Magic Eye settings.'});
    await wikiPage.editSettings({listed: false, permission_level: 2}); // mod only, not listed
    log.info('Finished creating default settings for', subredditName, '...');
}

async function updateSettings(subredditMulti, reddit) {
    log.debug('Checking for updated settings');
    const wikiChanges = await subredditMulti.getModerationLog({type: 'wikirevise'});
    const newChanges = wikiChanges.filter(change => change.details.includes('Page magic_eye edited') && change.mod != process.env.ACCOUNT_USERNAME);
    const unprocessedChanges = await consumeUnprocessedWikiChanges(newChanges);
    for (const change of unprocessedChanges) {
        const subredditName = await change.subreddit.display_name;
        await doUpdateSettings(subredditName, change, reddit);
    }
}

// overkill, but well tested
async function consumeUnprocessedWikiChanges(latestItems) {
    latestItems.sort((a, b) => { return a.created_utc - b.created_utc}); // oldest first

    const maxCheck = 500;
    if (latestItems.length > maxCheck) {
        log.info('Passed more than maxCheck items:', latestItems.length);
        latestItems = latestItems.slice(latestItems.length - maxCheck, latestItems.length);
    }

    // don't process anything over 3 hours old for safeguard. created_utc is in seconds/getTime is in millis.
    const threeHoursAgo = new Date().getTime() - 1000*60*60*3;
    latestItems = latestItems.filter(item => (item.created_utc * 1000) > threeHoursAgo); 

    const processedIds = await getMasterProperty('processed_wiki_changes');
    if (!processedIds) {
        log.warn(chalk.magenta('Could not find the last processed id list when retrieving unprocessed wiki changes. Regenerating...'));
        const intialProcessedIds = latestItems.map(submission => submission.id);
        await setMasterProperty('processed_wiki_changes', intialProcessedIds);
        return [];
    }  

    // update the processed list before processing so we don't retry any submissions that cause exceptions
    const newItems = latestItems.filter(item => !processedIds.includes(item.id));
    let updatedProcessedIds = processedIds.concat(newItems.map(submission => submission.id)); // [3,2,1] + [new] = [3,2,1,new]
    const processedCacheSize = maxCheck*5; // larger size for any weird/future edge-cases where a mod removes a lot of submissions
    if (updatedProcessedIds.length > processedCacheSize) { 
        updatedProcessedIds = updatedProcessedIds.slice(updatedProcessedIds.length - processedCacheSize); // [3,2,1,new] => [2,1,new]
    }
    await setMasterProperty('processed_wiki_changes', updatedProcessedIds);
    
    return newItems;
}



async function doUpdateSettings(subredditName, change, reddit) {
    log.info('Updating settings for', subredditName);
    const subreddit = await reddit.getSubreddit(subredditName); 
    const wikiPage = await subreddit.getWikiPage('magic_eye');
    let settings;
    try {
        settings = JSON.parse(await wikiPage.content_md);
    } catch (e) {
        sendFailureReply(change.mod);
        log.warn('Failed to update new settings for sub');
    }

    //var schemaValidator = new Validator();
    const result = true; //schemaValidator.validate(stringSettings, settingsSchema);

    if (result) {
        const masterSettings = await getSubredditSettings(subredditName);
        masterSettings.settings = settings;
        await setSubredditSettings(subredditName, masterSettings);
        await sendSuccessReply(change.mod, reddit);
        return settings;
    } else {
        await sendFailureReply(change.mod, reddit);
    }
}

async function sendSuccessReply(username, reddit) {
    await reddit.composeMessage({
        to: await username,
        subject: 'Success',
        text: 'Settings update successful. Lets nuke some posts!'
      });
}

async function sendFailureReply(username, reddit) {
    await reddit.composeMessage({
        to: await username,
        subject: 'Settings update failed',
        text: `The changes you made to your settings aren't formatted right so I haven't updated them. Either restore the last settings, or use https://jsonlint.com/ to find the issue.`
      });
}


const settingsSchema = ``;

module.exports = {
    updateSettings,
    createDefaultSettings,
};