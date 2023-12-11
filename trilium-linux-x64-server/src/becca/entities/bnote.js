"use strict";

const protectedSessionService = require('../../services/protected_session');
const log = require('../../services/log');
const sql = require('../../services/sql');
const utils = require('../../services/utils');
const dateUtils = require('../../services/date_utils');
const AbstractBeccaEntity = require("./abstract_becca_entity");
const BRevision = require("./brevision");
const BAttachment = require("./battachment");
const TaskContext = require("../../services/task_context");
const dayjs = require("dayjs");
const utc = require('dayjs/plugin/utc');
const eventService = require("../../services/events");
dayjs.extend(utc);

const LABEL = 'label';
const RELATION = 'relation';

/**
 * There are many different Note types, some of which are entirely opaque to the
 * end user. Those types should be used only for checking against, they are
 * not for direct use.
 * @typedef {"file" | "image" | "search" | "noteMap" | "launcher" | "doc" | "contentWidget" | "text" | "relationMap" | "render" | "canvas" | "mermaid" | "book" | "webView" | "code"} NoteType
 */

/**
 * @typedef {Object} NotePathRecord
 * @property {boolean} isArchived
 * @property {boolean} isInHoistedSubTree
 * @property {Array<string>} notePath
 * @property {boolean} isHidden
 */

/**
 * Trilium's main entity, which can represent text note, image, code note, file attachment etc.
 *
 * @extends AbstractBeccaEntity
 */
class BNote extends AbstractBeccaEntity {
    static get entityName() { return "notes"; }
    static get primaryKeyName() { return "noteId"; }
    static get hashedProperties() { return ["noteId", "title", "isProtected", "type", "mime", "blobId"]; }

    constructor(row) {
        super();

        if (!row) {
            return;
        }

        this.updateFromRow(row);
        this.init();
    }

    updateFromRow(row) {
        this.update([
            row.noteId,
            row.title,
            row.type,
            row.mime,
            row.isProtected,
            row.blobId,
            row.dateCreated,
            row.dateModified,
            row.utcDateCreated,
            row.utcDateModified
        ]);
    }

    update([noteId, title, type, mime, isProtected, blobId, dateCreated, dateModified, utcDateCreated, utcDateModified]) {
        // ------ Database persisted attributes ------

        /** @type {string} */
        this.noteId = noteId;
        /** @type {string} */
        this.title = title;
        /** @type {NoteType} */
        this.type = type;
        /** @type {string} */
        this.mime = mime;
        /** @type {boolean} */
        this.isProtected = !!isProtected;
        /** @type {string} */
        this.blobId = blobId;
        /** @type {string} */
        this.dateCreated = dateCreated || dateUtils.localNowDateTime();
        /** @type {string} */
        this.dateModified = dateModified;
        /** @type {string} */
        this.utcDateCreated = utcDateCreated || dateUtils.utcNowDateTime();
        /** @type {string} */
        this.utcDateModified = utcDateModified;
        /**
         * set during the deletion operation, before it is completed (removed from becca completely)
         * @type {boolean}
         */
        this.isBeingDeleted = false;

        // ------ Derived attributes ------

        /** @type {boolean} */
        this.isDecrypted = !this.noteId || !this.isProtected;

        this.decrypt();

        /** @type {string|null} */
        this.__flatTextCache = null;

        return this;
    }

    init() {
        /** @type {BBranch[]}
         * @private */
        this.parentBranches = [];
        /** @type {BNote[]}
         * @private */
        this.parents = [];
        /** @type {BNote[]}
         * @private */
        this.children = [];
        /** @type {BAttribute[]}
         * @private */
        this.ownedAttributes = [];

        /** @type {BAttribute[]|null}
         * @private */
        this.__attributeCache = null;
        /** @type {BAttribute[]|null}
         * @private */
        this.__inheritableAttributeCache = null;

        /** @type {BAttribute[]}
         * @private */
        this.targetRelations = [];

        this.becca.addNote(this.noteId, this);

        /** @type {BNote[]|null}
         * @private */
        this.__ancestorCache = null;

        // following attributes are filled during searching in the database

        /**
         * size of the content in bytes
         * @type {int|null}
         * @private
         */
        this.contentSize = null;
        /**
         * size of the note content, attachment contents in bytes
         * @type {int|null}
         * @private
         */
        this.contentAndAttachmentsSize = null;
        /**
         * size of the note content, attachment contents and revision contents in bytes
         * @type {int|null}
         * @private
         */
        this.contentAndAttachmentsAndRevisionsSize = null;
        /**
         * number of note revisions for this note
         * @type {int|null}
         * @private
         */
        this.revisionCount = null;
    }

    isContentAvailable() {
        return !this.noteId // new note which was not encrypted yet
            || !this.isProtected
            || protectedSessionService.isProtectedSessionAvailable()
    }

    getTitleOrProtected() {
        return this.isContentAvailable() ? this.title : '[protected]';
    }

    /** @returns {BBranch[]} */
    getParentBranches() {
        return this.parentBranches;
    }

    /**
     * Returns <i>strong</i> (as opposed to <i>weak</i>) parent branches. See isWeak for details.
     *
     * @returns {BBranch[]}
     */
    getStrongParentBranches() {
        return this.getParentBranches().filter(branch => !branch.isWeak);
    }

    /**
     * @returns {BBranch[]}
     * @deprecated use getParentBranches() instead
     */
    getBranches() {
        return this.parentBranches;
    }

    /** @returns {BNote[]} */
    getParentNotes() {
        return this.parents;
    }

    /** @returns {BNote[]} */
    getChildNotes() {
        return this.children;
    }

    /** @returns {boolean} */
    hasChildren() {
        return this.children && this.children.length > 0;
    }

    /** @returns {BBranch[]} */
    getChildBranches() {
        return this.children.map(childNote => this.becca.getBranchFromChildAndParent(childNote.noteId, this.noteId));
    }

    /*
     * Note content has quite special handling - it's not a separate entity, but a lazily loaded
     * part of Note entity with its own sync. Reasons behind this hybrid design has been:
     *
     * - content can be quite large, and it's not necessary to load it / fill memory for any note access even if we don't need a content, especially for bulk operations like search
     * - changes in the note metadata or title should not trigger note content sync (so we keep separate utcDateModified and entity changes records)
     * - but to the user note content and title changes are one and the same - single dateModified (so all changes must go through Note and content is not a separate entity)
     */

    /** @returns {string|Buffer}  */
    getContent() {
        return this._getContent();
    }

    /**
     * @returns {*}
     * @throws Error in case of invalid JSON */
    getJsonContent() {
        const content = this.getContent();

        if (!content || !content.trim()) {
            return null;
        }

        return JSON.parse(content);
    }

    /** @returns {*|null} valid object or null if the content cannot be parsed as JSON */
    getJsonContentSafely() {
        try {
            return this.getJsonContent();
        }
        catch (e) {
            return null;
        }
    }

    /**
     * @param content
     * @param {object} [opts]
     * @param {object} [opts.forceSave=false] - will also save this BNote entity
     * @param {object} [opts.forceFrontendReload=false] - override frontend heuristics on when to reload, instruct to reload
     */
    setContent(content, opts) {
        this._setContent(content, opts);

        eventService.emit(eventService.NOTE_CONTENT_CHANGE, { entity: this });
    }

    setJsonContent(content) {
        this.setContent(JSON.stringify(content, null, '\t'));
    }

    get dateCreatedObj() {
        return this.dateCreated === null ? null : dayjs(this.dateCreated);
    }

    get utcDateCreatedObj() {
        return this.utcDateCreated === null ? null : dayjs.utc(this.utcDateCreated);
    }

    get dateModifiedObj() {
        return this.dateModified === null ? null : dayjs(this.dateModified);
    }

    get utcDateModifiedObj() {
        return this.utcDateModified === null ? null : dayjs.utc(this.utcDateModified);
    }

    /** @returns {boolean} true if this note is the root of the note tree. Root note has "root" noteId */
    isRoot() {
        return this.noteId === 'root';
    }

    /** @returns {boolean} true if this note is of application/json content type */
    isJson() {
        return this.mime === "application/json";
    }

    /** @returns {boolean} true if this note is JavaScript (code or attachment) */
    isJavaScript() {
        return (this.type === "code" || this.type === "file" || this.type === 'launcher')
            && (this.mime.startsWith("application/javascript")
                || this.mime === "application/x-javascript"
                || this.mime === "text/javascript");
    }

    /** @returns {boolean} true if this note is HTML */
    isHtml() {
        return ["code", "file", "render"].includes(this.type)
            && this.mime === "text/html";
    }

    /** @returns {boolean} true if this note is an image */
    isImage() {
        return this.type === 'image'
            || (this.type === 'file' && this.mime?.startsWith('image/'));
    }

    /** @deprecated use hasStringContent() instead */
    isStringNote() {
        return this.hasStringContent();
    }

    /** @returns {boolean} true if the note has string content (not binary) */
    hasStringContent() {
        return utils.isStringNote(this.type, this.mime);
    }

    /** @returns {string|null} JS script environment - either "frontend" or "backend" */
    getScriptEnv() {
        if (this.isHtml() || (this.isJavaScript() && this.mime.endsWith('env=frontend'))) {
            return "frontend";
        }

        if (this.type === 'render') {
            return "frontend";
        }

        if (this.isJavaScript() && this.mime.endsWith('env=backend')) {
            return "backend";
        }

        return null;
    }

    /**
     * Beware that the method must not create a copy of the array, but actually returns its internal array
     * (for performance reasons)
     *
     * @param {string} [type] - (optional) attribute type to filter
     * @param {string} [name] - (optional) attribute name to filter
     * @returns {BAttribute[]} all note's attributes, including inherited ones
     */
    getAttributes(type, name) {
        this.__validateTypeName(type, name);
        this.__ensureAttributeCacheIsAvailable();

        if (type && name) {
            return this.__attributeCache.filter(attr => attr.name === name && attr.type === type);
        }
        else if (type) {
            return this.__attributeCache.filter(attr => attr.type === type);
        }
        else if (name) {
            return this.__attributeCache.filter(attr => attr.name === name);
        }
        else {
            return this.__attributeCache;
        }
    }

    /** @private */
    __ensureAttributeCacheIsAvailable() {
        if (!this.__attributeCache) {
            this.__getAttributes([]);
        }
    }

    /** @private */
    __getAttributes(path) {
        if (path.includes(this.noteId)) {
            return [];
        }

        if (!this.__attributeCache) {
            const parentAttributes = this.ownedAttributes.slice();
            const newPath = [...path, this.noteId];

            // inheritable attrs on root are typically not intended to be applied to hidden subtree #3537
            if (this.noteId !== 'root' && this.noteId !== '_hidden') {
                for (const parentNote of this.parents) {
                    parentAttributes.push(...parentNote.__getInheritableAttributes(newPath));
                }
            }

            const templateAttributes = [];

            for (const ownedAttr of parentAttributes) { // parentAttributes so we process also inherited templates
                if (ownedAttr.type === 'relation' && ['template', 'inherit'].includes(ownedAttr.name)) {
                    const templateNote = this.becca.notes[ownedAttr.value];

                    if (templateNote) {
                        templateAttributes.push(
                            ...templateNote.__getAttributes(newPath)
                                // template attr is used as a marker for templates, but it's not meant to be inherited
                                .filter(attr => !(attr.type === 'label' && (attr.name === 'template' || attr.name === 'workspacetemplate')))
                        );
                    }
                }
            }

            this.__attributeCache = [];

            const addedAttributeIds = new Set();

            for (const attr of parentAttributes.concat(templateAttributes)) {
                if (!addedAttributeIds.has(attr.attributeId)) {
                    addedAttributeIds.add(attr.attributeId);

                    this.__attributeCache.push(attr);
                }
            }

            this.__inheritableAttributeCache = [];

            for (const attr of this.__attributeCache) {
                if (attr.isInheritable) {
                    this.__inheritableAttributeCache.push(attr);
                }
            }
        }

        return this.__attributeCache;
    }

    /**
     * @private
     * @returns {BAttribute[]}
     */
    __getInheritableAttributes(path) {
        if (path.includes(this.noteId)) {
            return [];
        }

        if (!this.__inheritableAttributeCache) {
            this.__getAttributes(path); // will refresh also this.__inheritableAttributeCache
        }

        return this.__inheritableAttributeCache;
    }

    __validateTypeName(type, name) {
        if (type && type !== 'label' && type !== 'relation') {
            throw new Error(`Unrecognized attribute type '${type}'. Only 'label' and 'relation' are possible values.`);
        }

        if (name) {
            const firstLetter = name.charAt(0);
            if (firstLetter === '#' || firstLetter === '~') {
                throw new Error(`Detect '#' or '~' in the attribute's name. In the API, attribute names should be set without these characters.`);
            }
        }
    }

    /**
     * @param type
     * @param name
     * @param [value]
     * @returns {boolean}
     */
    hasAttribute(type, name, value = null) {
        return !!this.getAttributes().find(attr =>
            attr.name === name
            && (value === undefined || value === null || attr.value === value)
            && attr.type === type
        );
    }

    getAttributeCaseInsensitive(type, name, value) {
        name = name.toLowerCase();
        value = value ? value.toLowerCase() : null;

        return this.getAttributes().find(
            attr => attr.name.toLowerCase() === name
            && (!value || attr.value.toLowerCase() === value)
            && attr.type === type);
    }

    getRelationTarget(name) {
        const relation = this.getAttributes().find(attr => attr.name === name && attr.type === 'relation');

        return relation ? relation.targetNote : null;
    }

    /**
     * @param {string} name - label name
     * @param {string} [value] - label value
     * @returns {boolean} true if label exists (including inherited)
     */
    hasLabel(name, value) { return this.hasAttribute(LABEL, name, value); }

    /**
     * @param {string} name - label name
     * @returns {boolean} true if label exists (including inherited) and does not have "false" value.
     */
    isLabelTruthy(name) {
        const label = this.getLabel(name);

        if (!label) {
            return false;
        }

        return label && label.value !== 'false';
    }

    /**
     * @param {string} name - label name
     * @param {string} [value] - label value
     * @returns {boolean} true if label exists (excluding inherited)
     */
    hasOwnedLabel(name, value) { return this.hasOwnedAttribute(LABEL, name, value); }

    /**
     * @param {string} name - relation name
     * @param {string} [value] - relation value
     * @returns {boolean} true if relation exists (including inherited)
     */
    hasRelation(name, value) { return this.hasAttribute(RELATION, name, value); }

    /**
     * @param {string} name - relation name
     * @param {string} [value] - relation value
     * @returns {boolean} true if relation exists (excluding inherited)
     */
    hasOwnedRelation(name, value) { return this.hasOwnedAttribute(RELATION, name, value); }

    /**
     * @param {string} name - label name
     * @returns {BAttribute|null} label if it exists, null otherwise
     */
    getLabel(name) { return this.getAttribute(LABEL, name); }

    /**
     * @param {string} name - label name
     * @returns {BAttribute|null} label if it exists, null otherwise
     */
    getOwnedLabel(name) { return this.getOwnedAttribute(LABEL, name); }

    /**
     * @param {string} name - relation name
     * @returns {BAttribute|null} relation if it exists, null otherwise
     */
    getRelation(name) { return this.getAttribute(RELATION, name); }

    /**
     * @param {string} name - relation name
     * @returns {BAttribute|null} relation if it exists, null otherwise
     */
    getOwnedRelation(name) { return this.getOwnedAttribute(RELATION, name); }

    /**
     * @param {string} name - label name
     * @returns {string|null} label value if label exists, null otherwise
     */
    getLabelValue(name) { return this.getAttributeValue(LABEL, name); }

    /**
     * @param {string} name - label name
     * @returns {string|null} label value if label exists, null otherwise
     */
    getOwnedLabelValue(name) { return this.getOwnedAttributeValue(LABEL, name); }

    /**
     * @param {string} name - relation name
     * @returns {string|null} relation value if relation exists, null otherwise
     */
    getRelationValue(name) { return this.getAttributeValue(RELATION, name); }

    /**
     * @param {string} name - relation name
     * @returns {string|null} relation value if relation exists, null otherwise
     */
    getOwnedRelationValue(name) { return this.getOwnedAttributeValue(RELATION, name); }

    /**
     * @param {string} type - attribute type (label, relation, etc.)
     * @param {string} name - attribute name
     * @param {string} [value] - attribute value
     * @returns {boolean} true if note has an attribute with given type and name (excluding inherited)
     */
    hasOwnedAttribute(type, name, value) {
        return !!this.getOwnedAttribute(type, name, value);
    }

    /**
     * @param {string} type - attribute type (label, relation, etc.)
     * @param {string} name - attribute name
     * @returns {BAttribute} attribute of the given type and name. If there are more such attributes, first is returned.
     *                       Returns null if there's no such attribute belonging to this note.
     */
    getAttribute(type, name) {
        const attributes = this.getAttributes();

        return attributes.find(attr => attr.name === name && attr.type === type);
    }

    /**
     * @param {string} type - attribute type (label, relation, etc.)
     * @param {string} name - attribute name
     * @returns {string|null} attribute value of given type and name or null if no such attribute exists.
     */
    getAttributeValue(type, name) {
        const attr = this.getAttribute(type, name);

        return attr ? attr.value : null;
    }

    /**
     * @param {string} type - attribute type (label, relation, etc.)
     * @param {string} name - attribute name
     * @returns {string|null} attribute value of given type and name or null if no such attribute exists.
     */
    getOwnedAttributeValue(type, name) {
        const attr = this.getOwnedAttribute(type, name);

        return attr ? attr.value : null;
    }

    /**
     * @param {string} [name] - label name to filter
     * @returns {BAttribute[]} all note's labels (attributes with type label), including inherited ones
     */
    getLabels(name) {
        return this.getAttributes(LABEL, name);
    }

    /**
     * @param {string} [name] - label name to filter
     * @returns {string[]} all note's label values, including inherited ones
     */
    getLabelValues(name) {
        return this.getLabels(name).map(l => l.value);
    }

    /**
     * @param {string} [name] - label name to filter
     * @returns {BAttribute[]} all note's labels (attributes with type label), excluding inherited ones
     */
    getOwnedLabels(name) {
        return this.getOwnedAttributes(LABEL, name);
    }

    /**
     * @param {string} [name] - label name to filter
     * @returns {string[]} all note's label values, excluding inherited ones
     */
    getOwnedLabelValues(name) {
        return this.getOwnedAttributes(LABEL, name).map(l => l.value);
    }

    /**
     * @param {string} [name] - relation name to filter
     * @returns {BAttribute[]} all note's relations (attributes with type relation), including inherited ones
     */
    getRelations(name) {
        return this.getAttributes(RELATION, name);
    }

    /**
     * @param {string} [name] - relation name to filter
     * @returns {BAttribute[]} all note's relations (attributes with type relation), excluding inherited ones
     */
    getOwnedRelations(name) {
        return this.getOwnedAttributes(RELATION, name);
    }

    /**
     * Beware that the method must not create a copy of the array, but actually returns its internal array
     * (for performance reasons)
     *
     * @param {string|null} [type] - (optional) attribute type to filter
     * @param {string|null} [name] - (optional) attribute name to filter
     * @param {string|null} [value] - (optional) attribute value to filter
     * @returns {BAttribute[]} note's "owned" attributes - excluding inherited ones
     */
    getOwnedAttributes(type = null, name = null, value = null) {
        this.__validateTypeName(type, name);

        if (type && name && value !== undefined && value !== null) {
            return this.ownedAttributes.filter(attr => attr.name === name && attr.value === value && attr.type === type);
        }
        else if (type && name) {
            return this.ownedAttributes.filter(attr => attr.name === name && attr.type === type);
        }
        else if (type) {
            return this.ownedAttributes.filter(attr => attr.type === type);
        }
        else if (name) {
            return this.ownedAttributes.filter(attr => attr.name === name);
        }
        else {
            return this.ownedAttributes;
        }
    }

    /**
     * @returns {BAttribute} attribute belonging to this specific note (excludes inherited attributes)
     *
     * This method can be significantly faster than the getAttribute()
     */
    getOwnedAttribute(type, name, value = null) {
        const attrs = this.getOwnedAttributes(type, name, value);

        return attrs.length > 0 ? attrs[0] : null;
    }

    get isArchived() {
        return this.hasAttribute('label', 'archived');
    }

    areAllNotePathsArchived() {
        // there's a slight difference between note being itself archived and all its note paths being archived
        // - note is archived when it itself has an archived label or inherits it
        // - note does not have or inherit archived label, but each note path contains a note with (non-inheritable)
        //   archived label

        const bestNotePathRecord = this.getSortedNotePathRecords()[0];

        if (!bestNotePathRecord) {
            throw new Error(`No note path available for note '${this.noteId}'`);
        }

        return bestNotePathRecord.isArchived;
    }

    hasInheritableArchivedLabel() {
        for (const attr of this.getAttributes()) {
            if (attr.name === 'archived' && attr.type === LABEL && attr.isInheritable) {
                return true;
            }
        }

        return false;
    }

    // will sort the parents so that the non-archived are first and archived at the end
    // this is done so that the non-archived paths are always explored as first when looking for note path
    sortParents() {
        this.parentBranches.sort((a, b) => {
            if (a.parentNote?.isArchived) {
                return 1;
            } else if (a.parentNote?.isHiddenCompletely()) {
                return 1;
            } else {
                return 0;
            }
        });

        this.parents = this.parentBranches
            .map(branch => branch.parentNote)
            .filter(note => !!note);
    }

    sortChildren() {
        if (this.children.length === 0) {
            return;
        }

        const becca = this.becca;

        this.children.sort((a, b) => {
            const aBranch = becca.getBranchFromChildAndParent(a.noteId, this.noteId);
            const bBranch = becca.getBranchFromChildAndParent(b.noteId, this.noteId);

            return (aBranch?.notePosition - bBranch?.notePosition) || 0;
        });
    }

    /**
     * This is used for:
     * - fast searching
     * - note similarity evaluation
     *
     * @returns {string} - returns flattened textual representation of note, prefixes and attributes
     */
    getFlatText() {
        if (!this.__flatTextCache) {
            this.__flatTextCache = `${this.noteId} ${this.type} ${this.mime} `;

            for (const branch of this.parentBranches) {
                if (branch.prefix) {
                    this.__flatTextCache += `${branch.prefix} `;
                }
            }

            this.__flatTextCache += `${this.title} `;

            for (const attr of this.getAttributes()) {
                // it's best to use space as separator since spaces are filtered from the search string by the tokenization into words
                this.__flatTextCache += `${attr.type === 'label' ? '#' : '~'}${attr.name}`;

                if (attr.value) {
                    this.__flatTextCache += `=${attr.value}`;
                }

                this.__flatTextCache += ' ';
            }

            this.__flatTextCache = utils.normalize(this.__flatTextCache);
        }

        return this.__flatTextCache;
    }

    invalidateThisCache() {
        this.__flatTextCache = null;

        this.__attributeCache = null;
        this.__inheritableAttributeCache = null;
        this.__ancestorCache = null;
    }

    invalidateSubTree(path = []) {
        if (path.includes(this.noteId)) {
            return;
        }

        this.invalidateThisCache();

        if (this.children.length || this.targetRelations.length) {
            path = [...path, this.noteId];
        }

        for (const childNote of this.children) {
            childNote.invalidateSubTree(path);
        }

        for (const targetRelation of this.targetRelations) {
            if (targetRelation.name === 'template' || targetRelation.name === 'inherit') {
                const note = targetRelation.note;

                if (note) {
                    note.invalidateSubTree(path);
                }
            }
        }
    }

    getRelationDefinitions() {
        return this.getLabels()
            .filter(l => l.name.startsWith("relation:"));
    }

    getLabelDefinitions() {
        return this.getLabels()
            .filter(l => l.name.startsWith("relation:"));
    }

    isInherited() {
        return !!this.targetRelations.find(rel => rel.name === 'template' || rel.name === 'inherit');
    }

    /** @returns {BNote[]} */
    getSubtreeNotesIncludingTemplated() {
        const set = new Set();

        function inner(note) {
            // _hidden is not counted as subtree for the purpose of inheritance
            if (set.has(note) || note.noteId === '_hidden') {
                return;
            }

            set.add(note);

            for (const childNote of note.children) {
                inner(childNote);
            }

            for (const targetRelation of note.targetRelations) {
                if (targetRelation.name === 'template' || targetRelation.name === 'inherit') {
                    const targetNote = targetRelation.note;

                    if (targetNote) {
                        inner(targetNote);
                    }
                }
            }
        }

        inner(this);

        return Array.from(set);
    }

    /** @returns {BNote[]} */
    getSearchResultNotes() {
        if (this.type !== 'search') {
            return [];
        }

        try {
            const searchService = require("../../services/search/services/search");
            const {searchResultNoteIds} = searchService.searchFromNote(this);

            const becca = this.becca;
            return searchResultNoteIds
                .map(resultNoteId => becca.notes[resultNoteId])
                .filter(note => !!note);
        }
        catch (e) {
            log.error(`Could not resolve search note ${this.noteId}: ${e.message}`);
            return [];
        }
    }

    /**
     * @returns {{notes: BNote[], relationships: Array.<{parentNoteId: string, childNoteId: string}>}}
     */
    getSubtree({includeArchived = true, includeHidden = false, resolveSearch = false} = {}) {
        const noteSet = new Set();
        const relationships = []; // list of tuples parentNoteId -> childNoteId

        function resolveSearchNote(searchNote) {
            try {
                for (const resultNote of searchNote.getSearchResultNotes()) {
                    addSubtreeNotesInner(resultNote, searchNote);
                }
            }
            catch (e) {
                log.error(`Could not resolve search note ${searchNote?.noteId}: ${e.message}`);
            }
        }

        function addSubtreeNotesInner(note, parentNote = null) {
            if (note.noteId === '_hidden' && !includeHidden) {
                return;
            }

            if (parentNote) {
                // this needs to happen first before noteSet check to include all clone relationships
                relationships.push({
                    parentNoteId: parentNote.noteId,
                    childNoteId: note.noteId
                });
            }

            if (noteSet.has(note)) {
                return;
            }

            if (!includeArchived && note.isArchived) {
                return;
            }

            noteSet.add(note);

            if (note.type === 'search') {
                if (resolveSearch) {
                    resolveSearchNote(note);
                }
            }
            else {
                for (const childNote of note.children) {
                    addSubtreeNotesInner(childNote, note);
                }
            }
        }

        addSubtreeNotesInner(this);

        return {
            notes: Array.from(noteSet),
            relationships
        };
    }

    /** @returns {string[]} - includes the subtree root note as well */
    getSubtreeNoteIds({includeArchived = true, includeHidden = false, resolveSearch = false} = {}) {
        return this.getSubtree({includeArchived, includeHidden, resolveSearch})
            .notes
            .map(note => note.noteId);
    }

    /** @deprecated use getSubtreeNoteIds() instead */
    getDescendantNoteIds() {
        return this.getSubtreeNoteIds();
    }

    get parentCount() {
        return this.parents.length;
    }

    get childrenCount() {
        return this.children.length;
    }

    get labelCount() {
        return this.getAttributes().filter(attr => attr.type === 'label').length;
    }

    get ownedLabelCount() {
        return this.ownedAttributes.filter(attr => attr.type === 'label').length;
    }

    get relationCount() {
        return this.getAttributes().filter(attr => attr.type === 'relation' && !attr.isAutoLink()).length;
    }

    get relationCountIncludingLinks() {
        return this.getAttributes().filter(attr => attr.type === 'relation').length;
    }

    get ownedRelationCount() {
        return this.ownedAttributes.filter(attr => attr.type === 'relation' && !attr.isAutoLink()).length;
    }

    get ownedRelationCountIncludingLinks() {
        return this.ownedAttributes.filter(attr => attr.type === 'relation').length;
    }

    get targetRelationCount() {
        return this.targetRelations.filter(attr => !attr.isAutoLink()).length;
    }

    get targetRelationCountIncludingLinks() {
        return this.targetRelations.length;
    }

    get attributeCount() {
        return this.getAttributes().length;
    }

    get ownedAttributeCount() {
        return this.getOwnedAttributes().length;
    }

    /** @returns {BNote[]} */
    getAncestors() {
        if (!this.__ancestorCache) {
            const noteIds = new Set();
            this.__ancestorCache = [];

            for (const parent of this.parents) {
                if (noteIds.has(parent.noteId)) {
                    continue;
                }

                this.__ancestorCache.push(parent);
                noteIds.add(parent.noteId);

                for (const ancestorNote of parent.getAncestors()) {
                    if (!noteIds.has(ancestorNote.noteId)) {
                        this.__ancestorCache.push(ancestorNote);
                        noteIds.add(ancestorNote.noteId);
                    }
                }
            }
        }

        return this.__ancestorCache;
    }

    /** @returns {string[]} */
    getAncestorNoteIds() {
        return this.getAncestors().map(note => note.noteId);
    }

    /** @returns {boolean} */
    hasAncestor(ancestorNoteId) {
        for (const ancestorNote of this.getAncestors()) {
            if (ancestorNote.noteId === ancestorNoteId) {
                return true;
            }
        }

        return false;
    }

    isInHiddenSubtree() {
        return this.noteId === '_hidden' || this.hasAncestor('_hidden');
    }

    /** @returns {BAttribute[]} */
    getTargetRelations() {
        return this.targetRelations;
    }

    /** @returns {BNote[]} - returns only notes which are templated, does not include their subtrees
     *                     in effect returns notes which are influenced by note's non-inheritable attributes */
    getInheritingNotes() {
        const arr = [this];

        for (const targetRelation of this.targetRelations) {
            if (targetRelation.name === 'template' || targetRelation.name === 'inherit') {
                const note = targetRelation.note;

                if (note) {
                    arr.push(note);
                }
            }
        }

        return arr;
    }

    getDistanceToAncestor(ancestorNoteId) {
        if (this.noteId === ancestorNoteId) {
            return 0;
        }

        let minDistance = 999999;

        for (const parent of this.parents) {
            minDistance = Math.min(minDistance, parent.getDistanceToAncestor(ancestorNoteId) + 1);
        }

        return minDistance;
    }

    /** @returns {BRevision[]} */
    getRevisions() {
        return sql.getRows("SELECT * FROM revisions WHERE noteId = ?", [this.noteId])
            .map(row => new BRevision(row));
    }

    /** @returns {BAttachment[]} */
    getAttachments(opts = {}) {
        opts.includeContentLength = !!opts.includeContentLength;
        // from testing, it looks like calculating length does not make a difference in performance even on large-ish DB
        // given that we're always fetching attachments only for a specific note, we might just do it always

        const query = opts.includeContentLength
            ? `SELECT attachments.*, LENGTH(blobs.content) AS contentLength
               FROM attachments 
               JOIN blobs USING (blobId) 
               WHERE ownerId = ? AND isDeleted = 0 
               ORDER BY position`
            : `SELECT * FROM attachments WHERE ownerId = ? AND isDeleted = 0 ORDER BY position`;

        return sql.getRows(query, [this.noteId])
            .map(row => new BAttachment(row));
    }

    /** @returns {BAttachment|null} */
    getAttachmentById(attachmentId, opts = {}) {
        opts.includeContentLength = !!opts.includeContentLength;

        const query = opts.includeContentLength
            ? `SELECT attachments.*, LENGTH(blobs.content) AS contentLength
               FROM attachments 
               JOIN blobs USING (blobId) 
               WHERE ownerId = ? AND attachmentId = ? AND isDeleted = 0`
            : `SELECT * FROM attachments WHERE ownerId = ? AND attachmentId = ? AND isDeleted = 0`;

        return sql.getRows(query, [this.noteId, attachmentId])
            .map(row => new BAttachment(row))[0];
    }

    /** @returns {BAttachment[]} */
    getAttachmentsByRole(role) {
        return sql.getRows(`
                SELECT attachments.*
                FROM attachments 
                WHERE ownerId = ? 
                  AND role = ?
                  AND isDeleted = 0
                ORDER BY position`, [this.noteId, role])
            .map(row => new BAttachment(row));
    }

    /** @returns {BAttachment} */
    getAttachmentByTitle(title) {
        // cannot use SQL to filter by title since it can be encrypted
        return this.getAttachments().filter(attachment => attachment.title === title)[0];
    }

    /**
     * Gives all possible note paths leading to this note. Paths containing search note are ignored (could form cycles)
     *
     * @returns {string[][]} - array of notePaths (each represented by array of noteIds constituting the particular note path)
     */
    getAllNotePaths() {
        if (this.noteId === 'root') {
            return [['root']];
        }

        const parentNotes = this.getParentNotes();

        const notePaths = parentNotes.length === 1
            ? parentNotes[0].getAllNotePaths() // optimization for the most common case
            : parentNotes.flatMap(parentNote => parentNote.getAllNotePaths());

        for (const notePath of notePaths) {
            notePath.push(this.noteId);
        }

        return notePaths;
    }

    /**
     * @param {string} [hoistedNoteId='root']
     * @return {Array<NotePathRecord>}
     */
    getSortedNotePathRecords(hoistedNoteId = 'root') {
        const isHoistedRoot = hoistedNoteId === 'root';

        const notePaths = this.getAllNotePaths().map(path => ({
            notePath: path,
            isInHoistedSubTree: isHoistedRoot || path.includes(hoistedNoteId),
            isArchived: path.some(noteId => this.becca.notes[noteId].isArchived),
            isHidden: path.includes('_hidden')
        }));

        notePaths.sort((a, b) => {
            if (a.isInHoistedSubTree !== b.isInHoistedSubTree) {
                return a.isInHoistedSubTree ? -1 : 1;
            } else if (a.isArchived !== b.isArchived) {
                return a.isArchived ? 1 : -1;
            } else if (a.isHidden !== b.isHidden) {
                return a.isHidden ? 1 : -1;
            } else {
                return a.notePath.length - b.notePath.length;
            }
        });

        return notePaths;
    }

    /**
     * Returns a note path considered to be the "best"
     *
     * @param {string} [hoistedNoteId='root']
     * @return {string[]} array of noteIds constituting the particular note path
     */
    getBestNotePath(hoistedNoteId = 'root') {
        return this.getSortedNotePathRecords(hoistedNoteId)[0]?.notePath;
    }

    /**
     * Returns a note path considered to be the "best"
     *
     * @param {string} [hoistedNoteId='root']
     * @return {string} serialized note path (e.g. 'root/a1h315/js725h')
     */
    getBestNotePathString(hoistedNoteId = 'root') {
        const notePath = this.getBestNotePath(hoistedNoteId);

        return notePath?.join("/");
    }

    /**
     * @return boolean - true if there's no non-hidden path, note is not cloned to the visible tree
     */
    isHiddenCompletely() {
        if (this.noteId === 'root') {
            return false;
        }

        for (const parentNote of this.parents) {
            if (parentNote.noteId === 'root') {
                return false;
            } else if (parentNote.noteId === '_hidden') {
                continue;
            } else if (!parentNote.isHiddenCompletely()) {
                return false;
            }
        }

        return true;
    }

    /**
     * @param ancestorNoteId
     * @returns {boolean} - true if ancestorNoteId occurs in at least one of the note's paths
     */
    isDescendantOfNote(ancestorNoteId) {
        const notePaths = this.getAllNotePaths();

        return notePaths.some(path => path.includes(ancestorNoteId));
    }

    /**
     * Update's given attribute's value or creates it if it doesn't exist
     *
     * @param {string} type - attribute type (label, relation, etc.)
     * @param {string} name - attribute name
     * @param {string} [value] - attribute value (optional)
     */
    setAttribute(type, name, value) {
        const attributes = this.getOwnedAttributes();
        const attr = attributes.find(attr => attr.type === type && attr.name === name);

        value = value?.toString() || "";

        if (attr) {
            if (attr.value !== value) {
                attr.value = value;
                attr.save();
            }
        }
        else {
            const BAttribute = require("./battribute");

            new BAttribute({
                noteId: this.noteId,
                type: type,
                name: name,
                value: value
            }).save();
        }
    }

    /**
     * Removes given attribute name-value pair if it exists.
     *
     * @param {string} type - attribute type (label, relation, etc.)
     * @param {string} name - attribute name
     * @param {string} [value] - attribute value (optional)
     */
    removeAttribute(type, name, value) {
        const attributes = this.getOwnedAttributes();

        for (const attribute of attributes) {
            if (attribute.type === type && attribute.name === name && (value === undefined || value === attribute.value)) {
                attribute.markAsDeleted();
            }
        }
    }

    /**
     * Adds a new attribute to this note. The attribute is saved and returned.
     * See addLabel, addRelation for more specific methods.
     *
     * @param {string} type - attribute type (label / relation)
     * @param {string} name - name of the attribute, not including the leading ~/#
     * @param {string} [value] - value of the attribute - text for labels, target note ID for relations; optional.
     * @param {boolean} [isInheritable=false]
     * @param {int|null} [position]
     * @returns {BAttribute}
     */
    addAttribute(type, name, value = "", isInheritable = false, position = null) {
        const BAttribute = require("./battribute");

        return new BAttribute({
            noteId: this.noteId,
            type: type,
            name: name,
            value: value,
            isInheritable: isInheritable,
            position: position
        }).save();
    }

    /**
     * Adds a new label to this note. The label attribute is saved and returned.
     *
     * @param {string} name - name of the label, not including the leading #
     * @param {string} [value] - text value of the label; optional
     * @param {boolean} [isInheritable=false]
     * @returns {BAttribute}
     */
    addLabel(name, value = "", isInheritable = false) {
        return this.addAttribute(LABEL, name, value, isInheritable);
    }

    /**
     * Adds a new relation to this note. The relation attribute is saved and
     * returned.
     *
     * @param {string} name - name of the relation, not including the leading ~
     * @param {string} targetNoteId
     * @param {boolean} [isInheritable=false]
     * @returns {BAttribute}
     */
    addRelation(name, targetNoteId, isInheritable = false) {
        return this.addAttribute(RELATION, name, targetNoteId, isInheritable);
    }

    /**
     * Based on enabled, the attribute is either set or removed.
     *
     * @param {string} type - attribute type ('relation', 'label' etc.)
     * @param {boolean} enabled - toggle On or Off
     * @param {string} name - attribute name
     * @param {string} [value] - attribute value (optional)
     */
    toggleAttribute(type, enabled, name, value) {
        if (enabled) {
            this.setAttribute(type, name, value);
        }
        else {
            this.removeAttribute(type, name, value);
        }
    }

    /**
     * Based on enabled, label is either set or removed.
     *
     * @param {boolean} enabled - toggle On or Off
     * @param {string} name - label name
     * @param {string} [value] - label value (optional)
     */
    toggleLabel(enabled, name, value) { return this.toggleAttribute(LABEL, enabled, name, value); }

    /**
     * Based on enabled, relation is either set or removed.
     *
     * @param {boolean} enabled - toggle On or Off
     * @param {string} name - relation name
     * @param {string} [value] - relation value (noteId)
     */
    toggleRelation(enabled, name, value) { return this.toggleAttribute(RELATION, enabled, name, value); }

    /**
     * Update's given label's value or creates it if it doesn't exist
     *
     * @param {string} name - label name
     * @param {string} [value] - label value
     */
    setLabel(name, value) { return this.setAttribute(LABEL, name, value); }

    /**
     * Update's given relation's value or creates it if it doesn't exist
     *
     * @param {string} name - relation name
     * @param {string} value - relation value (noteId)
     */
    setRelation(name, value) { return this.setAttribute(RELATION, name, value); }

    /**
     * Remove label name-value pair, if it exists.
     *
     * @param {string} name - label name
     * @param {string} [value] - label value
     */
    removeLabel(name, value) { return this.removeAttribute(LABEL, name, value); }

    /**
     * Remove the relation name-value pair, if it exists.
     *
     * @param {string} name - relation name
     * @param {string} [value] - relation value (noteId)
     */
    removeRelation(name, value) { return this.removeAttribute(RELATION, name, value); }

    searchNotesInSubtree(searchString) {
        const searchService = require("../../services/search/services/search");

        return searchService.searchNotes(searchString);
    }

    searchNoteInSubtree(searchString) {
        return this.searchNotesInSubtree(searchString)[0];
    }

    /**
     * @param parentNoteId
     * @returns {{success: boolean, message: string, branchId: string, notePath: string}}
     */
    cloneTo(parentNoteId) {
        const cloningService = require("../../services/cloning");

        const branch = this.becca.getNote(parentNoteId).getParentBranches()[0];

        return cloningService.cloneNoteToBranch(this.noteId, branch.branchId);
    }

    isEligibleForConversionToAttachment(opts = {autoConversion: false}) {
        if (this.type !== 'image' || !this.isContentAvailable() || this.hasChildren() || this.getParentBranches().length !== 1) {
            return false;
        }

        const targetRelations = this.getTargetRelations().filter(relation => relation.name === 'imageLink');

        if (opts.autoConversion && targetRelations.length === 0) {
            return false;
        } else if (targetRelations.length > 1) {
            return false;
        }

        const parentNote = this.getParentNotes()[0]; // at this point note can have only one parent
        const referencingNote = targetRelations[0]?.getNote();

        if (referencingNote && parentNote !== referencingNote) {
            return false;
        } else if (parentNote.type !== 'text' || !parentNote.isContentAvailable()) {
            return false;
        }

        return true;
    }

    /**
     * Some notes are eligible for conversion into an attachment of its parent, note must have these properties:
     * - it has exactly one target relation
     * - it has a relation from its parent note
     * - it has no children
     * - it has no clones
     * - the parent is of type text
     * - both notes are either unprotected or user is in protected session
     *
     * Currently, works only for image notes.
     *
     * In the future, this functionality might get more generic and some of the requirements relaxed.
     *
     * @params {Object} [opts]
     * @params {bolean} [opts.autoConversion=false} if true, the action is not triggered by user, but e.g. by migration,
     *                                              and only perfect candidates will be migrated
     *
     * @returns {BAttachment|null} - null if note is not eligible for conversion
     */
    convertToParentAttachment(opts = {autoConversion: false}) {
        if (!this.isEligibleForConversionToAttachment(opts)) {
            return null;
        }

        const content = this.getContent();

        const parentNote = this.getParentNotes()[0];
        const attachment = parentNote.saveAttachment({
            role: 'image',
            mime: this.mime,
            title: this.title,
            content: content
        });

        let parentContent = parentNote.getContent();

        const oldNoteUrl = `api/images/${this.noteId}/`;
        const newAttachmentUrl = `api/attachments/${attachment.attachmentId}/image/`;

        const fixedContent = utils.replaceAll(parentContent, oldNoteUrl, newAttachmentUrl);

        parentNote.setContent(fixedContent);

        const noteService = require("../../services/notes");
        noteService.asyncPostProcessContent(parentNote, fixedContent); // to mark an unused attachment for deletion

        this.deleteNote();

        return attachment;
    }

    /**
     * (Soft) delete a note and all its descendants.
     *
     * @param {string} [deleteId=null] - optional delete identified
     * @param {TaskContext} [taskContext]
     */
    deleteNote(deleteId = null, taskContext = null) {
        if (this.isDeleted) {
            return;
        }

        if (!deleteId) {
            deleteId = utils.randomString(10);
        }

        if (!taskContext) {
            taskContext = new TaskContext('no-progress-reporting');
        }

        // needs to be run before branches and attributes are deleted and thus attached relations disappear
        const handlers = require("../../services/handlers");
        handlers.runAttachedRelations(this, 'runOnNoteDeletion', this);
        taskContext.noteDeletionHandlerTriggered = true;

        for (const branch of this.getParentBranches()) {
            branch.deleteBranch(deleteId, taskContext);
        }
    }

    decrypt() {
        if (this.isProtected && !this.isDecrypted && protectedSessionService.isProtectedSessionAvailable()) {
            try {
                this.title = protectedSessionService.decryptString(this.title);
                this.__flatTextCache = null;

                this.isDecrypted = true;
            }
            catch (e) {
                log.error(`Could not decrypt note ${this.noteId}: ${e.message} ${e.stack}`);
            }
        }
    }

    isLaunchBarConfig() {
        return this.type === 'launcher' || ['_lbRoot', '_lbAvailableLaunchers', '_lbVisibleLaunchers'].includes(this.noteId);
    }

    isOptions() {
        return this.noteId.startsWith("_options");
    }

    get isDeleted() {
        // isBeingDeleted is relevant only in the transition period when the deletion process has begun, but not yet
        // finished (note is still in becca)
        return !(this.noteId in this.becca.notes) || this.isBeingDeleted;
    }

    /**
     * @returns {BRevision|null}
     */
    saveRevision() {
        return sql.transactional(() => {
            let noteContent = this.getContent();

            const revision = new BRevision({
                noteId: this.noteId,
                // title and text should be decrypted now
                title: this.title,
                type: this.type,
                mime: this.mime,
                isProtected: this.isProtected,
                utcDateLastEdited: this.utcDateModified,
                utcDateCreated: dateUtils.utcNowDateTime(),
                utcDateModified: dateUtils.utcNowDateTime(),
                dateLastEdited: this.dateModified,
                dateCreated: dateUtils.localNowDateTime()
            }, true);

            revision.save(); // to generate revisionId, which is then used to save attachments

            for (const noteAttachment of this.getAttachments()) {
                const revisionAttachment = noteAttachment.copy();
                revisionAttachment.ownerId = revision.revisionId;
                revisionAttachment.setContent(noteAttachment.getContent(), {forceSave: true});

                if (this.type === 'text') {
                    // content is rewritten to point to the revision attachments
                    noteContent = noteContent.replaceAll(`attachments/${noteAttachment.attachmentId}`,
                        `attachments/${revisionAttachment.attachmentId}`);

                    noteContent = noteContent.replaceAll(new RegExp(`href="[^"]*attachmentId=${noteAttachment.attachmentId}[^"]*"`, 'gi'),
                        `href="api/attachments/${revisionAttachment.attachmentId}/download"`);
                }
            }

            revision.setContent(noteContent);

            return revision;
        });
    }

    /**
     * @param {string} matchBy - choose by which property we detect if to update an existing attachment.
 *                               Supported values are either 'attachmentId' (default) or 'title'
     * @returns {BAttachment}
     */
    saveAttachment({attachmentId, role, mime, title, content, position}, matchBy = 'attachmentId') {
        if (!['attachmentId', 'title'].includes(matchBy)) {
            throw new Error(`Unsupported value '${matchBy}' for matchBy param, has to be either 'attachmentId' or 'title'.`);
        }

        let attachment;

        if (matchBy === 'title') {
            attachment = this.getAttachmentByTitle(title);
        } else if (matchBy === 'attachmentId' && attachmentId) {
            attachment = this.becca.getAttachmentOrThrow(attachmentId);
        }

        attachment = attachment || new BAttachment({
            ownerId: this.noteId,
            title,
            role,
            mime,
            isProtected: this.isProtected,
            position
        });

        content = content || "";
        attachment.setContent(content, {forceSave: true});

        return attachment;
    }

    getFileName() {
        return utils.formatDownloadTitle(this.title, this.type, this.mime);
    }

    beforeSaving() {
        super.beforeSaving();

        this.becca.addNote(this.noteId, this);

        this.dateModified = dateUtils.localNowDateTime();
        this.utcDateModified = dateUtils.utcNowDateTime();
    }

    getPojo() {
        return {
            noteId: this.noteId,
            title: this.title,
            isProtected: this.isProtected,
            type: this.type,
            mime: this.mime,
            blobId: this.blobId,
            isDeleted: false,
            dateCreated: this.dateCreated,
            dateModified: this.dateModified,
            utcDateCreated: this.utcDateCreated,
            utcDateModified: this.utcDateModified
        };
    }

    getPojoToSave() {
        const pojo = this.getPojo();

        if (pojo.isProtected) {
            if (this.isDecrypted) {
                pojo.title = protectedSessionService.encrypt(pojo.title);
            }
            else {
                // updating protected note outside of protected session means we will keep original ciphertexts
                delete pojo.title;
            }
        }

        return pojo;
    }
}

module.exports = BNote;
