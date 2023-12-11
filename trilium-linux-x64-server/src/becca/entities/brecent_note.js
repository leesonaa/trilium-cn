"use strict";

const dateUtils = require('../../services/date_utils');
const AbstractBeccaEntity = require("./abstract_becca_entity");

/**
 * RecentNote represents recently visited note.
 *
 * @extends AbstractBeccaEntity
 */
class BRecentNote extends AbstractBeccaEntity {
    static get entityName() { return "recent_notes"; }
    static get primaryKeyName() { return "noteId"; }

    constructor(row) {
        super();

        /** @type {string} */
        this.noteId = row.noteId;
        /** @type {string} */
        this.notePath = row.notePath;
        /** @type {string} */
        this.utcDateCreated = row.utcDateCreated || dateUtils.utcNowDateTime();
    }

    getPojo() {
        return {
            noteId: this.noteId,
            notePath: this.notePath,
            utcDateCreated: this.utcDateCreated
        }
    }
}

module.exports = BRecentNote;
