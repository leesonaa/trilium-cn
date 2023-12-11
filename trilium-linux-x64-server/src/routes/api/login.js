"use strict";

const options = require('../../services/options');
const utils = require('../../services/utils');
const dateUtils = require('../../services/date_utils');
const instanceId = require('../../services/instance_id');
const passwordEncryptionService = require('../../services/encryption/password_encryption');
const protectedSessionService = require('../../services/protected_session');
const appInfo = require('../../services/app_info');
const eventService = require('../../services/events');
const sqlInit = require('../../services/sql_init');
const sql = require('../../services/sql');
const ws = require("../../services/ws");
const etapiTokenService = require("../../services/etapi_tokens");

function loginSync(req) {
    if (!sqlInit.schemaExists()) {
        return [500, { message: "数据库不存在, 无法同步." }];
    }

    const timestampStr = req.body.timestamp;

    const timestamp = dateUtils.parseDateTime(timestampStr);

    const now = new Date();

    // login token is valid for 5 minutes
    if (Math.abs(timestamp.getTime() - now.getTime()) > 5 * 60 * 1000) {
        return [401, { message: 'Auth request time is out of sync, please check that both client and server have correct time. The difference between clocks has to be smaller than 5 minutes.' }];
    }

    const syncVersion = req.body.syncVersion;

    if (syncVersion !== appInfo.syncVersion) {
        return [400, { message: `同步版本不匹配, 本地版本 ${appInfo.syncVersion}, 远程版本 ${syncVersion}. 建议服务端和客户端运行相同版本的 Trilium.` }];
    }

    const documentSecret = options.getOption('documentSecret');
    const expectedHash = utils.hmac(documentSecret, timestampStr);

    const givenHash = req.body.hash;

    if (expectedHash !== givenHash) {
        return [400, { message: "同步登录凭据不正确. 看起来您正在尝试同步两个不同的已初始化文档, 操作失败." }];
    }

    req.session.loggedIn = true;

    return {
        instanceId: instanceId,
        maxEntityChangeId: sql.getValue("SELECT COALESCE(MAX(id), 0) FROM entity_changes WHERE isSynced = 1")
    };
}

function loginToProtectedSession(req) {
    const password = req.body.password;

    if (!passwordEncryptionService.verifyPassword(password)) {
        return {
            success: false,
            message: "输入的密码哈希值不匹配."
        };
    }

    const decryptedDataKey = passwordEncryptionService.getDataKey(password);

    protectedSessionService.setDataKey(decryptedDataKey);

    eventService.emit(eventService.ENTER_PROTECTED_SESSION);

    ws.sendMessageToAllClients({ type: 'protectedSessionLogin' });

    return {
        success: true
    };
}

function logoutFromProtectedSession() {
    protectedSessionService.resetDataKey();

    eventService.emit(eventService.LEAVE_PROTECTED_SESSION);

    ws.sendMessageToAllClients({ type: 'protectedSessionLogout' });
}

function touchProtectedSession() {
    protectedSessionService.touchProtectedSession();
}

function token(req) {
    const password = req.body.password;

    if (!passwordEncryptionService.verifyPassword(password)) {
        return [401, "密码错误"];
    }

    // for backwards compatibility with Sender which does not send the name
    const tokenName = req.body.tokenName || "Trilium Sender / Web Clipper";

    const {authToken} = etapiTokenService.createToken(tokenName);

    return { token: authToken };
}

module.exports = {
    loginSync,
    loginToProtectedSession,
    logoutFromProtectedSession,
    touchProtectedSession,
    token
};
