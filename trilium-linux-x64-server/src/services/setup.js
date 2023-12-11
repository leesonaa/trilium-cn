const syncService = require('./sync');
const log = require('./log');
const sqlInit = require('./sql_init');
const optionService = require('./options');
const syncOptions = require('./sync_options');
const request = require('./request');
const appInfo = require('./app_info');
const utils = require('./utils');
const becca = require("../becca/becca");

async function hasSyncServerSchemaAndSeed() {
    const response = await requestToSyncServer('GET', '/api/setup/status');

    if (response.syncVersion !== appInfo.syncVersion) {
        throw new Error(`无法设置同步,因为本地同步协议版本是 ${appInfo.syncVersion} 而远程是 ${response.syncVersion}. 要修复这个问题, 请保证所有Trilium服务端和客户端都使用相同的版本`);
    }

    return response.schemaExists;
}

function triggerSync() {
    log.info("Triggering sync.");

    // it's ok to not wait for it here
    syncService.sync().then(res => {
        if (res.success) {
            sqlInit.setDbAsInitialized();
        }
    });
}

async function sendSeedToSyncServer() {
    log.info("Initiating sync to server");

    await requestToSyncServer('POST', '/api/setup/sync-seed', {
        options: getSyncSeedOptions(),
        syncVersion: appInfo.syncVersion
    });

    // this is a completely new sync, need to reset counters. If this was not a new sync,
    // the previous request would have failed.
    optionService.setOption('lastSyncedPush', 0);
    optionService.setOption('lastSyncedPull', 0);
}

async function requestToSyncServer(method, path, body = null) {
    const timeout = syncOptions.getSyncTimeout();

    return await utils.timeLimit(request.exec({
        method,
        url: syncOptions.getSyncServerHost() + path,
        body,
        proxy: syncOptions.getSyncProxy(),
        timeout: timeout
    }), timeout);
}

async function setupSyncFromSyncServer(syncServerHost, syncProxy, password) {
    if (sqlInit.isDbInitialized()) {
        return {
            result: 'failure',
            error: 'DB is already initialized.'
        };
    }

    try {
        log.info("Getting document options FROM sync server.");

        // the response is expected to contain documentId and documentSecret options
        const resp = await request.exec({
            method: 'get',
            url: `${syncServerHost}/api/setup/sync-seed`,
            auth: { password },
            proxy: syncProxy,
            timeout: 30000 // seed request should not take long
        });

        if (resp.syncVersion !== appInfo.syncVersion) {
            const message = `Could not setup sync since local sync protocol version is ${appInfo.syncVersion} while remote is ${resp.syncVersion}. To fix this issue, use same Trilium version on all instances.`;

            log.error(message);

            return {
                result: 'failure',
                error: message
            }
        }

        sqlInit.createDatabaseForSync(resp.options, syncServerHost, syncProxy);

        triggerSync();

        return { result: 'success' };
    }
    catch (e) {
        log.error(`Sync failed: '${e.message}', stack: ${e.stack}`);

        return {
            result: 'failure',
            error: e.message
        };
    }
}

function getSyncSeedOptions() {
    return [
        becca.getOption('documentId'),
        becca.getOption('documentSecret')
    ];
}

module.exports = {
    hasSyncServerSchemaAndSeed,
    triggerSync,
    sendSeedToSyncServer,
    setupSyncFromSyncServer,
    getSyncSeedOptions
};
