// run.js

// Node.js built-in modules
const { exec: execCallback } = require('child_process');
const { randomUUID } = require('crypto');
const util = require('util');

// Promisify exec for the gcloud command
const exec = util.promisify(execCallback);

// Third-party packages
const axios = require('axios');
const chalk = require('chalk');
const { highlight } = require('cli-highlight');
const cliProgress = require('cli-progress');

// --- CONFIGURATION ---

// Salesforce REST API Configuration
// NOTE: In a production environment, these secrets should be loaded from environment variables or a secure vault.
const SF_LOGIN_URL = 'https://checkatrade.my.salesforce.com/services/oauth2/token';
const SF_CLIENT_ID = '3MVG9tzQRhEbH_K2nO6Y9U.mkX6vMr4kd5RYcJKbzV9coeUFON2.MUdZLYt8HiL.lgOn12_V7rqyREXTTd_mm';
const SF_CLIENT_SECRET = '2F3ED825E6D5221DA36DC23DCD08D882C95D71F83CD3BF9BAC501B9AA1B20BC4';
const SF_API_VERSION = 'v63.0'; // A recent, stable API version
const SF_SOQL_QUERY = "SELECT Id, CaseNumber, Subject, Type, Description, Origin, CreatedDate FROM Case WHERE Type IN ('Membership Advice', 'Member Retention') AND CaseTierCategorisation__c = null AND Origin IN ('Web', 'Email') AND CreatedDate = LAST_N_DAYS:2 AND Subtype__c != 'Optimisation Campaign' ORDER BY CreatedDate DESC";

// External API Configuration
const API_BASE_URL = 'https://api.checkatrade.com/v1/ma-routing-agent';
const APP_NAME = 'ma_routing_agent';
const USER_ID_TEMPLATE = 'u_salesforce';

// UI/UX Configuration
const LOG_DELAY_MS = 750;

// --- HELPER FUNCTIONS ---
function pause(ms) {
    if (ms === 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- LOGGING HELPERS ---
const log = {
    step: async (message) => {
        await pause(LOG_DELAY_MS);
        // Added extra newline for spacing
        console.log(chalk.blue.bold(`\n\n▶ ${message}`));
    },
    info: (message) => console.log(chalk.white(`  ${message}`)),
    success: (message) => console.log(chalk.green.bold(`  ✔ ${message}`)),
    error: (message, details) => {
        console.log(chalk.red.bold(`  ✖ ERROR: ${message}`));
        if (details) {
            console.log(chalk.red(`    Details: ${details.replace(/\n/g, '\n    ')}`));
        }
    },
    data: (data) => console.log(chalk.gray(`    ${data}`)),
    json: (obj, title) => {
        if (title) { console.log(chalk.gray(`    ${title}:`)); }
        const jsonString = JSON.stringify(obj, null, 2);
        const coloredJson = highlight(jsonString, { language: 'json', ignoreIllegals: true });
        console.log(coloredJson.split('\n').map(line => `    ${line}`).join('\n'));
    },
};

// --- AUTHENTICATION FUNCTIONS ---

/**
 * Fetches the Google Cloud identity token.
 */
async function getGCloudToken() {
    await log.step('Step 1: Fetching Google Cloud Identity Token');
    try {
        const { stdout } = await exec('gcloud auth print-identity-token');
        log.success('Token retrieved successfully.');
        return stdout.trim();
    } catch (err) {
        log.error('Failed to get GCloud token.', err.stderr || err.message);
        throw new Error('Failed to get GCloud token.');
    }
}

/**
 * NEW: Fetches the Salesforce access token using Client Credentials flow.
 * @returns {Promise<{accessToken: string, instanceUrl: string}>}
 */
async function getSalesforceAuth() {
    await log.step('Step 2: Authenticating with Salesforce via REST API');
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', SF_CLIENT_ID);
    params.append('client_secret', SF_CLIENT_SECRET);

    try {
        const response = await axios.post(SF_LOGIN_URL, params);
        log.success('Salesforce authentication successful.');
        return {
            accessToken: response.data.access_token,
            instanceUrl: response.data.instance_url
        };
    } catch (err) {
        const errorDetails = err.response ? JSON.stringify(err.response.data) : err.message;
        log.error('Salesforce authentication failed.', errorDetails);
        throw new Error('Could not authenticate with Salesforce.');
    }
}

// --- API INTERACTION FUNCTIONS ---

/**
 * REWRITTEN & SIMPLIFIED: Fetches Salesforce cases and the total count in one go.
 * @param {{accessToken: string, instanceUrl: string}} sfAuth - Salesforce authentication object.
 * @returns {Promise<{cases: Array<Object>, totalInSalesforce: number}>} An object containing the cases to process and the total number matching the query in Salesforce.
 */
async function getSalesforceCasesAndTotalCount(sfAuth) {
    await log.step('Step 3: Querying Salesforce for Cases and Total Count');
    const encodedQuery = encodeURIComponent(SF_SOQL_QUERY);
    const url = `${sfAuth.instanceUrl}/services/data/${SF_API_VERSION}/query?q=${encodedQuery}`;
    log.info(`GET from ${url}`);

    try {
        const response = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${sfAuth.accessToken}` }
        });

        const casesToProcess = response.data.records;
        // The `totalSize` property correctly reflects the total number of records matching the SOQL WHERE clause.
        const totalInSalesforce = response.data.totalSize;

        log.success(`Found a total of ${totalInSalesforce} matching case(s) in Salesforce.`);
        if (casesToProcess.length === 0) {
            log.info('The current batch is empty; no cases to process.');
        } else {
            log.info(`This batch contains ${casesToProcess.length} case(s) to process (due to LIMIT clause).`);
        }

        return { cases: casesToProcess, totalInSalesforce: totalInSalesforce };

    } catch (err) {
        const errorDetails = err.response ? JSON.stringify(err.response.data) : err.message;
        log.error('Failed to query Salesforce cases.', errorDetails);
        throw new Error('Could not query Salesforce cases.');
    }
}


/**
 * Creates a session with the external API. (Unchanged)
 */
async function createSession(token, caseId) {
    await log.step(`Step 4: Creating External API Session for Case ID ${caseId}`);
    const sessionId = `s_${randomUUID()}`;
    const url = `${API_BASE_URL}/apps/${APP_NAME}/users/${USER_ID_TEMPLATE}/sessions/${sessionId}`;
    const payload = { state: { visit_count: 0, preferred_language: 'English' } };
    log.info(`POST to ${url}`);
    log.json(payload, 'Payload');
    try {
        const response = await axios.post(url, payload, { headers: { 'Authorization': `Bearer ${token}` } });
        log.success('Session created successfully.');
        log.json(response.data, 'Response');
        return response.data;
    } catch (err) {
        const errorDetails = err.response ? JSON.stringify(err.response.data) : 'No response body.';
        log.error(`API Call failed: ${err.message}`, errorDetails);
        throw new Error('Failed to create API session.');
    }
}

/**
 * Runs the main task on the external API. (Unchanged)
 */
async function runSseTaskAndGetResponse(token, sessionData, caseRecord) {
    await log.step('Step 5: Running Main Task on External API');
    const url = `${API_BASE_URL}/run_sse`;
    const messagePayload = { id: caseRecord.Id, Type: caseRecord.Type, Subject: caseRecord.Subject, Description: caseRecord.Description, Origin: caseRecord.Origin};
    const payload = {
        app_name: sessionData.appName, userId: sessionData.userId, session_id: sessionData.id,
        new_message: { role: 'user', parts: [{ text: JSON.stringify(messagePayload) }] }, streaming: false,
    };
    log.info(`POST to ${url}`);
    log.json(payload, 'Payload');
    try {
        const response = await axios.post(url, payload, { headers: { 'Authorization': `Bearer ${token}` } });
        log.success('Received SSE response successfully.');
        await log.step('Step 6: Parsing SSE Response for final_json');
        const events = response.data.split('\n\n');
        for (const event of events) {
            if (event.startsWith('data:')) {
                try {
                    const data = JSON.parse(event.substring(5).trim());
                    if (data.author === 'json_generator' && data.actions?.stateDelta?.final_json) {
                        const finalJson = data.actions.stateDelta.final_json;
                        log.success('Found "final_json" object.');
                        log.json(finalJson);
                        return finalJson;
                    }
                } catch (parseError) { /* Ignore non-JSON lines */ }
            }
        }
        throw new Error('Could not find "final_json" in the SSE response.');
    } catch (err) {
        const errorDetails = err.response ? err.response.data : 'No response body.';
        log.error(`API Call or Parsing failed: ${err.message}`, errorDetails);
        throw new Error('Failed to run SSE task or parse its response.');
    }
}

/**
 * REWRITTEN: Updates a Salesforce Case using the REST API.
 * @param {{accessToken: string, instanceUrl: string}} sfAuth - Salesforce authentication object.
 * @param {Object} updatePayload - The JSON object containing update data, including CaseId.
 */
async function updateSalesforceCase(sfAuth, updatePayload) {
    const caseId = updatePayload.CaseId;
    await log.step(`Step 7: Updating Salesforce Case ${caseId} via REST API`);
    if (!caseId) { throw new Error('Update payload is missing "CaseId".'); }

    // Prepare the request body by removing the ID field.
    const body = { ...updatePayload };
    delete body.CaseId;

    const url = `${sfAuth.instanceUrl}/services/data/${SF_API_VERSION}/sobjects/Case/${caseId}`;

    log.info(`PATCH to ${url}`);
    log.json(body, 'Update Payload');

    try {
        const response = await axios.patch(url, body, {
            headers: {
                'Authorization': `Bearer ${sfAuth.accessToken}`,
                'Content-Type': 'application/json'
            }
        });
        // A successful PATCH returns 204 No Content.
        if (response.status === 204) {
            log.success(`Case ${caseId} updated successfully in Salesforce.`);
        } else {
            throw new Error(`Unexpected status code: ${response.status}`);
        }
    } catch (err) {
        const errorDetails = err.response ? JSON.stringify(err.response.data) : err.message;
        log.error(`Salesforce update failed.`, errorDetails);
        throw new Error(`Failed to update Salesforce Case ${caseId}.`);
    }
}


/**
 * Main orchestration function.
 */
async function main() {
    console.log(chalk.yellow.bold('--- Starting Salesforce Case Triage Process ---'));
    try {
        const gcloudToken = await getGCloudToken();
        const sfAuth = await getSalesforceAuth();

        // Get the batch of cases to process and the total count in one go
        const { cases, totalInSalesforce } = await getSalesforceCasesAndTotalCount(sfAuth);

        if (cases.length === 0) {
            await pause(LOG_DELAY_MS);
            console.log(chalk.yellow.bold('\n\n--- Process Complete: No cases needed processing. ---'));
            return;
        }

        // --- PROGRESS BAR START ---
        console.log(''); // Newline for cleaner layout
        const progressBar = new cliProgress.SingleBar({
            format: `Progress | ${chalk.cyan('{bar}')} | {percentage}% | {value}/{total} processed`,
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true,
            forceRedraw: true,
            linewrap: true,
            clearOnComplete: false,
        });
        progressBar.start(cases.length, 0);
        // --- PROGRESS BAR END ---


        for (const caseRecord of cases) {
            await pause(LOG_DELAY_MS);
            // Added extra newline for spacing
            console.log(chalk.yellow.bold(`\n\n\n\n\n\n================== Processing Case: ${caseRecord.CaseNumber} (${caseRecord.CreatedDate}) ==================`));
            try {
                const sessionData = await createSession(gcloudToken, caseRecord.Id);
                const updatePayload = await runSseTaskAndGetResponse(gcloudToken, sessionData, caseRecord);
                await updateSalesforceCase(sfAuth, updatePayload);
                console.log(chalk.cyan.bold(`================== Finished Case: ${caseRecord.CaseNumber} ==================`));
            } catch (caseError) {
                log.error(`Failed to process Case ${caseRecord.CaseNumber}. Skipping to next case.`);
                console.log(chalk.red.bold(`================== Error on Case: ${caseRecord.CaseNumber} ==================\n`));
            }
            progressBar.increment(); // Update progress after each case
        }

        progressBar.stop(); // Stop the progress bar

        await pause(LOG_DELAY_MS);
        // Added extra newline for spacing
        console.log(chalk.yellow.bold('\n\n--- Process Complete: All cases have been processed. ---'));
    } catch (globalError) {
        // Added extra newline for spacing
        console.log(chalk.red.bold('\n\n--- Process Aborted Due to Critical Error ---'));
        process.exit(1);
    }
}

main();
