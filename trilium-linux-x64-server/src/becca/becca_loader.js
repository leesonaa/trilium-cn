"use strict";

const sql = require('../services/sql');
const eventService = require('../services/events');
const becca = require('./becca');
const sqlInit = require('../services/sql_init');
const log = require('../services/log');
const BNote = require('./entities/bnote');
const BBranch = require('./entities/bbranch');
const BAttribute = require('./entities/battribute');
const BOption = require('./entities/boption');
const BEtapiToken = require("./entities/betapi_token");
const cls = require("../services/cls");
const entityConstructor = require("../becca/entity_constructor");

const beccaLoaded = new Promise((res, rej) => {
    sqlInit.dbReady.then(() => {
        cls.init(() => {
            load();

            require('../services/options_init').initStartupOptions();

            res();
        });
    });
});

function load() {
    const start = Date.now();
    becca.reset();

    // we know this is slow and the total becca load time is logged
    sql.disableSlowQueryLogging(() => {
        // using a raw query and passing arrays to avoid allocating new objects,
        // this is worth it for the becca load since it happens every run and blocks the app until finished

        for (const row of sql.getRawRows(`SELECT noteId, title, type, mime, isProtected, blobId, dateCreated, dateModified, utcDateCreated, utcDateModified FROM notes WHERE isDeleted = 0`)) {
            new BNote().update(row).init();
        }

        const branchRows = sql.getRawRows(`SELECT branchId, noteId, parentNoteId, prefix, notePosition, isExpanded, utcDateModified FROM branches WHERE isDeleted = 0`);
        // in-memory sort is faster than in the DB
        branchRows.sort((a, b) => a.notePosition - b.notePosition);

        for (const row of branchRows) {
            new BBranch().update(row).init();
        }

        for (const row of sql.getRawRows(`SELECT attributeId, noteId, type, name, value, isInheritable, position, utcDateModified FROM attributes WHERE isDeleted = 0`)) {
            new BAttribute().update(row).init();
        }

        for (const row of sql.getRows(`SELECT name, value, isSynced, utcDateModified FROM options`)) {
            new BOption(row);
        }

        for (const row of sql.getRows(`SELECT etapiTokenId, name, tokenHash, utcDateCreated, utcDateModified FROM etapi_tokens WHERE isDeleted = 0`)) {
            new BEtapiToken(row);
        }
    });

    for (const noteId in becca.notes) {
        becca.notes[noteId].sortParents();
    }

    becca.loaded = true;

    log.info(`Becca (note cache) load took ${Date.now() - start}ms`);
}

function reload(reason) {
    load();

    require('../services/ws').reloadFrontend(reason || "becca reloaded");
}

eventService.subscribeBeccaLoader([eventService.ENTITY_CHANGE_SYNCED],  ({entityName, entityRow}) => {
    if (!becca.loaded) {
        return;
    }

    if (["notes", "branches", "attributes", "etapi_tokens", "options"].includes(entityName)) {
        const EntityClass = entityConstructor.getEntityFromEntityName(entityName);
        const primaryKeyName = EntityClass.primaryKeyName;

        let beccaEntity = becca.getEntity(entityName, entityRow[primaryKeyName]);

        if (beccaEntity) {
            beccaEntity.updateFromRow(entityRow);
        } else {
            beccaEntity = new EntityClass();
            beccaEntity.updateFromRow(entityRow);
            beccaEntity.init();
        }
    }

    postProcessEntityUpdate(entityName, entityRow);
});

eventService.subscribeBeccaLoader(eventService.ENTITY_CHANGED,  ({entityName, entity}) => {
    if (!becca.loaded) {
        return;
    }

    postProcessEntityUpdate(entityName, entity);
});

/**
 * This gets run on entity being created or updated.
 *
 * @param entityName
 * @param entityRow - can be a becca entity (change comes from this trilium instance) or just a row (from sync).
 *                    It should be therefore treated as a row.
 */
function postProcessEntityUpdate(entityName, entityRow) {
    if (entityName === 'notes') {
        noteUpdated(entityRow);
    } else if (entityName === 'branches') {
        branchUpdated(entityRow);
    } else if (entityName === 'attributes') {
        attributeUpdated(entityRow);
    } else if (entityName === 'note_reordering') {
        noteReorderingUpdated(entityRow);
    }
}

eventService.subscribeBeccaLoader([eventService.ENTITY_DELETED, eventService.ENTITY_DELETE_SYNCED],  ({entityName, entityId}) => {
    if (!becca.loaded) {
        return;
    }

    if (entityName === 'notes') {
        noteDeleted(entityId);
    } else if (entityName === 'branches') {
        branchDeleted(entityId);
    } else if (entityName === 'attributes') {
        attributeDeleted(entityId);
    } else if (entityName === 'etapi_tokens') {
        etapiTokenDeleted(entityId);
    }
});

function noteDeleted(noteId) {
    delete becca.notes[noteId];

    becca.dirtyNoteSetCache();
}

function branchDeleted(branchId) {
    const branch = becca.branches[branchId];

    if (!branch) {
        return;
    }

    const childNote = becca.notes[branch.noteId];

    if (childNote) {
        childNote.parents = childNote.parents.filter(parent => parent.noteId !== branch.parentNoteId);
        childNote.parentBranches = childNote.parentBranches
            .filter(parentBranch => parentBranch.branchId !== branch.branchId);

        if (childNote.parents.length > 0) {
            // subtree notes might lose some inherited attributes
            childNote.invalidateSubTree();
        }
    }

    const parentNote = becca.notes[branch.parentNoteId];

    if (parentNote) {
        parentNote.children = parentNote.children.filter(child => child.noteId !== branch.noteId);
    }

    delete becca.childParentToBranch[`${branch.noteId}-${branch.parentNoteId}`];
    delete becca.branches[branch.branchId];
}

function noteUpdated(entityRow) {
    const note = becca.notes[entityRow.noteId];

    if (note) {
        // type / mime could have been changed, and they are present in flatTextCache
        note.flatTextCache = null;
    }
}

function branchUpdated(branchRow) {
    const childNote = becca.notes[branchRow.noteId];

    if (childNote) {
        childNote.flatTextCache = null;
        childNote.sortParents();

        // notes in the subtree can get new inherited attributes
        // this is in theory needed upon branch creation, but there's no "create" event for sync changes
        childNote.invalidateSubTree();
    }

    const parentNote = becca.notes[branchRow.parentNoteId];

    if (parentNote) {
        parentNote.sortChildren();
    }
}

function attributeDeleted(attributeId) {
    const attribute = becca.attributes[attributeId];

    if (!attribute) {
        return;
    }

    const note = becca.notes[attribute.noteId];

    if (note) {
        // first invalidate and only then remove the attribute (otherwise invalidation wouldn't be complete)
        if (attribute.isAffectingSubtree || note.isInherited()) {
            note.invalidateSubTree();
        } else {
            note.invalidateThisCache();
        }

        note.ownedAttributes = note.ownedAttributes.filter(attr => attr.attributeId !== attribute.attributeId);

        const targetNote = attribute.targetNote;

        if (targetNote) {
            targetNote.targetRelations = targetNote.targetRelations.filter(rel => rel.attributeId !== attribute.attributeId);
        }
    }

    delete becca.attributes[attribute.attributeId];

    const key = `${attribute.type}-${attribute.name.toLowerCase()}`;

    if (key in becca.attributeIndex) {
        becca.attributeIndex[key] = becca.attributeIndex[key].filter(attr => attr.attributeId !== attribute.attributeId);
    }
}

/** @param {BAttribute} attributeRow */
function attributeUpdated(attributeRow) {
    const attribute = becca.attributes[attributeRow.attributeId];
    const note = becca.notes[attributeRow.noteId];

    if (note) {
        if (attribute.isAffectingSubtree || note.isInherited()) {
            note.invalidateSubTree();
        } else {
            note.invalidateThisCache();
        }
    }
}

function noteReorderingUpdated(branchIdList) {
    const parentNoteIds = new Set();

    for (const branchId in branchIdList) {
        const branch = becca.branches[branchId];

        if (branch) {
            branch.notePosition = branchIdList[branchId];

            parentNoteIds.add(branch.parentNoteId);
        }
    }
}

function etapiTokenDeleted(etapiTokenId) {
    delete becca.etapiTokens[etapiTokenId];
}

eventService.subscribeBeccaLoader(eventService.ENTER_PROTECTED_SESSION, () => {
    try {
        becca.decryptProtectedNotes();
    }
    catch (e) {
        log.error(`Could not decrypt protected notes: ${e.message} ${e.stack}`);
    }
});

eventService.subscribeBeccaLoader(eventService.LEAVE_PROTECTED_SESSION, load);

module.exports = {
    load,
    reload,
    beccaLoaded
};
