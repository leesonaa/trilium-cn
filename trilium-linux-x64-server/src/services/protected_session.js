"use strict";

const log = require('./log');
const dataEncryptionService = require('./encryption/data_encryption');

let dataKey = null;

function setDataKey(decryptedDataKey) {
    dataKey = Array.from(decryptedDataKey);
}

function getDataKey() {
    return dataKey;
}

function resetDataKey() {
    dataKey = null;
}

function isProtectedSessionAvailable() {
    return !!dataKey;
}

function encrypt(plainText) {
    if (plainText === null) {
        return null;
    }

    return dataEncryptionService.encrypt(getDataKey(), plainText);
}

function decrypt(cipherText) {
    if (cipherText === null) {
        return null;
    }

    return dataEncryptionService.decrypt(getDataKey(), cipherText);
}

function decryptString(cipherText) {
    return dataEncryptionService.decryptString(getDataKey(), cipherText);
}

let lastProtectedSessionOperationDate = null;

function touchProtectedSession() {
    if (isProtectedSessionAvailable()) {
        lastProtectedSessionOperationDate = Date.now();
    }
}

function checkProtectedSessionExpiration() {
    const options = require("./options");
    const protectedSessionTimeout = options.getOptionInt('protectedSessionTimeout');
    if (isProtectedSessionAvailable()
        && lastProtectedSessionOperationDate
        && Date.now() - lastProtectedSessionOperationDate > protectedSessionTimeout * 1000) {

        resetDataKey();

        log.info("Expiring protected session");

        require('./ws').reloadFrontend("leaving protected session");
    }
}

module.exports = {
    setDataKey,
    resetDataKey,
    isProtectedSessionAvailable,
    encrypt,
    decrypt,
    decryptString,
    touchProtectedSession,
    checkProtectedSessionExpiration
};
