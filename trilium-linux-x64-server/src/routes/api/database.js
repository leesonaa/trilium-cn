"use strict";

const sql = require('../../services/sql');
const log = require('../../services/log');
const backupService = require('../../services/backup');
const anonymizationService = require('../../services/anonymization');
const consistencyChecksService = require('../../services/consistency_checks');

function getExistingBackups() {
    return backupService.getExistingBackups();
}

async function backupDatabase() {
    return {
        backupFile: await backupService.backupNow("now")
    };
}

function vacuumDatabase() {
    sql.execute("VACUUM");

    log.info("Database has been vacuumed.");
}

function findAndFixConsistencyIssues() {
    consistencyChecksService.runOnDemandChecks(true);
}

function getExistingAnonymizedDatabases() {
    return anonymizationService.getExistingAnonymizedDatabases();
}

async function anonymize(req) {
    return await anonymizationService.createAnonymizedCopy(req.params.type);
}

function checkIntegrity() {
    const results = sql.getRows("PRAGMA integrity_check");

    log.info(`Integrity check result: ${JSON.stringify(results)}`);

    return {
        results
    };
}

module.exports = {
    getExistingBackups,
    backupDatabase,
    vacuumDatabase,
    findAndFixConsistencyIssues,
    getExistingAnonymizedDatabases,
    anonymize,
    checkIntegrity
};
