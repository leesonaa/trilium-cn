"use strict";

const normalizeString = require("normalize-strings");
const lex = require('./lex');
const handleParens = require('./handle_parens');
const parse = require('./parse');
const SearchResult = require("../search_result");
const SearchContext = require("../search_context");
const becca = require('../../../becca/becca');
const beccaService = require('../../../becca/becca_service');
const utils = require('../../utils');
const log = require('../../log');
const hoistedNoteService = require("../../hoisted_note");

function searchFromNote(note) {
    let searchResultNoteIds, highlightedTokens;

    const searchScript = note.getRelationValue('searchScript');
    const searchString = note.getLabelValue('searchString');
    let error = null;

    if (searchScript) {
        searchResultNoteIds = searchFromRelation(note, 'searchScript');
        highlightedTokens = [];
    } else {
        const searchContext = new SearchContext({
            fastSearch: note.hasLabel('fastSearch'),
            ancestorNoteId: note.getRelationValue('ancestor'),
            ancestorDepth: note.getLabelValue('ancestorDepth'),
            includeArchivedNotes: note.hasLabel('includeArchivedNotes'),
            orderBy: note.getLabelValue('orderBy'),
            orderDirection: note.getLabelValue('orderDirection'),
            limit: note.getLabelValue('limit'),
            debug: note.hasLabel('debug'),
            fuzzyAttributeSearch: false
        });

        searchResultNoteIds = findResultsWithQuery(searchString, searchContext)
            .map(sr => sr.noteId);

        highlightedTokens = searchContext.highlightedTokens;
        error = searchContext.getError();
    }

    // we won't return search note's own noteId
    // also don't allow root since that would force infinite cycle
    return {
        searchResultNoteIds: searchResultNoteIds.filter(resultNoteId => !['root', note.noteId].includes(resultNoteId)),
        highlightedTokens,
        error: error
    };
}

function searchFromRelation(note, relationName) {
    const scriptNote = note.getRelationTarget(relationName);

    if (!scriptNote) {
        log.info(`Search note's relation ${relationName} has not been found.`);

        return [];
    }

    if (!scriptNote.isJavaScript() || scriptNote.getScriptEnv() !== 'backend') {
        log.info(`Note ${scriptNote.noteId} is not executable.`);

        return [];
    }

    if (!note.isContentAvailable()) {
        log.info(`Note ${scriptNote.noteId} is not available outside of protected session.`);

        return [];
    }

    const scriptService = require("../../script"); // to avoid circular dependency
    const result = scriptService.executeNote(scriptNote, {originEntity: note});

    if (!Array.isArray(result)) {
        log.info(`Result from ${scriptNote.noteId} is not an array.`);

        return [];
    }

    if (result.length === 0) {
        return [];
    }

    // we expect either array of noteIds (strings) or notes, in that case we extract noteIds ourselves
    return typeof result[0] === 'string' ? result : result.map(item => item.noteId);
}

function loadNeededInfoFromDatabase() {
    const sql = require('../../sql');

    /**
     * This complex structure is needed to calculate total occupied space by a note. Several object instances
     * (note, revisions, attachments) can point to a single blobId, and thus the blob size should count towards the total
     * only once.
     *
     * @var {Object.<string, Object.<string, int>>} - noteId => { blobId => blobSize }
     */
    const noteBlobs = {};

    const noteContentLengths = sql.getRows(`
        SELECT 
            noteId, 
            blobId,
            LENGTH(content) AS length 
        FROM notes
             JOIN blobs USING(blobId) 
        WHERE notes.isDeleted = 0`);

    for (const {noteId, blobId, length} of noteContentLengths) {
        if (!(noteId in becca.notes)) {
            log.error(`Note '${noteId}' not found in becca.`);
            continue;
        }

        becca.notes[noteId].contentSize = length;
        becca.notes[noteId].revisionCount = 0;

        noteBlobs[noteId] = { [blobId]: length };
    }

    const attachmentContentLengths = sql.getRows(`
        SELECT
            ownerId AS noteId,
            attachments.blobId,
            LENGTH(content) AS length
        FROM attachments
            JOIN notes ON attachments.ownerId = notes.noteId
            JOIN blobs ON attachments.blobId = blobs.blobId
        WHERE attachments.isDeleted = 0 
            AND notes.isDeleted = 0`);

    for (const {noteId, blobId, length} of attachmentContentLengths) {
        if (!(noteId in becca.notes)) {
            log.error(`Note '${noteId}' not found in becca.`);
            continue;
        }

        if (!(noteId in noteBlobs)) {
            log.error(`Did not find a '${noteId}' in the noteBlobs.`);
            continue;
        }

        noteBlobs[noteId][blobId] = length;
    }

    for (const noteId in noteBlobs) {
        becca.notes[noteId].contentAndAttachmentsSize = Object.values(noteBlobs[noteId]).reduce((acc, size) => acc + size, 0);
    }

    const revisionContentLengths = sql.getRows(`
            SELECT 
                noteId, 
                revisions.blobId,
                LENGTH(content) AS length,
                1 AS isNoteRevision
            FROM notes
                JOIN revisions USING(noteId) 
                JOIN blobs ON revisions.blobId = blobs.blobId
            WHERE notes.isDeleted = 0
        UNION ALL
            SELECT
                noteId,
                revisions.blobId,
                LENGTH(content) AS length,
                0 AS isNoteRevision -- it's attachment not counting towards revision count
            FROM notes
                JOIN revisions USING(noteId)
                JOIN attachments ON attachments.ownerId = revisions.revisionId
                JOIN blobs ON attachments.blobId = blobs.blobId
            WHERE notes.isDeleted = 0`);

    for (const {noteId, blobId, length, isNoteRevision} of revisionContentLengths) {
        if (!(noteId in becca.notes)) {
            log.error(`Note '${noteId}' not found in becca.`);
            continue;
        }

        if (!(noteId in noteBlobs)) {
            log.error(`Did not find a '${noteId}' in the noteBlobs.`);
            continue;
        }

        noteBlobs[noteId][blobId] = length;

        if (isNoteRevision) {
            becca.notes[noteId].revisionCount++;
        }
    }

    for (const noteId in noteBlobs) {
        becca.notes[noteId].contentAndAttachmentsAndRevisionsSize = Object.values(noteBlobs[noteId]).reduce((acc, size) => acc + size, 0);
    }
}

/**
 * @param {Expression} expression
 * @param {SearchContext} searchContext
 * @returns {SearchResult[]}
 */
function findResultsWithExpression(expression, searchContext) {
    if (searchContext.dbLoadNeeded) {
        loadNeededInfoFromDatabase();
    }

    const allNoteSet = becca.getAllNoteSet();

    const executionContext = {
        noteIdToNotePath: {}
    };

    const noteSet = expression.execute(allNoteSet, executionContext, searchContext);

    const searchResults = noteSet.notes
        .map(note => {
            const notePathArray = executionContext.noteIdToNotePath[note.noteId] || note.getBestNotePath();

            if (!notePathArray) {
                throw new Error(`Can't find note path for note ${JSON.stringify(note.getPojo())}`);
            }

            return new SearchResult(notePathArray);
        });

    for (const res of searchResults) {
        res.computeScore(searchContext.fulltextQuery, searchContext.highlightedTokens);
    }

    if (!noteSet.sorted) {
        searchResults.sort((a, b) => {
            if (a.score > b.score) {
                return -1;
            } else if (a.score < b.score) {
                return 1;
            }

            // if score does not decide then sort results by depth of the note.
            // This is based on the assumption that more important results are closer to the note root.
            if (a.notePathArray.length === b.notePathArray.length) {
                return a.notePathTitle < b.notePathTitle ? -1 : 1;
            }

            return a.notePathArray.length < b.notePathArray.length ? -1 : 1;
        });
    }

    return searchResults;
}

function parseQueryToExpression(query, searchContext) {
    const {fulltextQuery, fulltextTokens, expressionTokens} = lex(query);
    searchContext.fulltextQuery = fulltextQuery;

    let structuredExpressionTokens;

    try {
        structuredExpressionTokens = handleParens(expressionTokens);
    }
    catch (e) {
        structuredExpressionTokens = [];
        searchContext.addError(e.message);
    }

    const expression = parse({
        fulltextTokens,
        expressionTokens: structuredExpressionTokens,
        searchContext,
        originalQuery: query
    });

    if (searchContext.debug) {
        searchContext.debugInfo = {
            fulltextTokens,
            structuredExpressionTokens,
            expression
        };

        log.info(`Search debug: ${JSON.stringify(searchContext.debugInfo, null, 4)}`);
    }

    return expression;
}

/**
 * @param {string} query
 * @param {object} params - see SearchContext
 * @returns {BNote[]}
 */
function searchNotes(query, params = {}) {
    const searchResults = findResultsWithQuery(query, new SearchContext(params));

    return searchResults.map(sr => becca.notes[sr.noteId]);
}

/**
 * @param {string} query
 * @param {SearchContext} searchContext
 * @returns {SearchResult[]}
 */
function findResultsWithQuery(query, searchContext) {
    query = query || "";
    searchContext.originalQuery = query;

    const expression = parseQueryToExpression(query, searchContext);

    if (!expression) {
        return [];
    }

    return findResultsWithExpression(expression, searchContext);
}

/**
 * @param {string} query
 * @param {SearchContext} searchContext
 * @returns {BNote|null}
 */
function findFirstNoteWithQuery(query, searchContext) {
    const searchResults = findResultsWithQuery(query, searchContext);

    return searchResults.length > 0 ? becca.notes[searchResults[0].noteId] : null;
}

function searchNotesForAutocomplete(query) {
    const searchContext = new SearchContext({
        fastSearch: true,
        includeArchivedNotes: false,
        includeHiddenNotes: true,
        fuzzyAttributeSearch: true,
        ancestorNoteId: hoistedNoteService.isHoistedInHiddenSubtree()
            ? 'root'
            : hoistedNoteService.getHoistedNoteId()
    });

    const allSearchResults = findResultsWithQuery(query, searchContext);

    const trimmed = allSearchResults.slice(0, 200);

    highlightSearchResults(trimmed, searchContext.highlightedTokens);

    return trimmed.map(result => {
        return {
            notePath: result.notePath,
            noteTitle: beccaService.getNoteTitle(result.noteId),
            notePathTitle: result.notePathTitle,
            highlightedNotePathTitle: result.highlightedNotePathTitle
        };
    });
}

function highlightSearchResults(searchResults, highlightedTokens) {
    highlightedTokens = Array.from(new Set(highlightedTokens));

    // we remove < signs because they can cause trouble in matching and overwriting existing highlighted chunks
    // which would make the resulting HTML string invalid.
    // { and } are used for marking <b> and </b> tag (to avoid matches on single 'b' character)
    // < and > are used for marking <small> and </small>
    highlightedTokens = highlightedTokens
        .map(token => token.replace('/[<\{\}]/g', ''))
        .filter(token => !!token?.trim());

    // sort by the longest, so we first highlight the longest matches
    highlightedTokens.sort((a, b) => a.length > b.length ? -1 : 1);

    for (const result of searchResults) {
        const note = becca.notes[result.noteId];

        result.highlightedNotePathTitle = result.notePathTitle.replace(/[<{}]/g, '');

        if (highlightedTokens.find(token => note.type.includes(token))) {
            result.highlightedNotePathTitle += ` "type: ${note.type}'`;
        }

        if (highlightedTokens.find(token => note.mime.includes(token))) {
            result.highlightedNotePathTitle += ` "mime: ${note.mime}'`;
        }

        for (const attr of note.getAttributes()) {
            if (highlightedTokens.find(token => utils.normalize(attr.name).includes(token)
                || utils.normalize(attr.value).includes(token))) {

                result.highlightedNotePathTitle += ` "${formatAttribute(attr)}'`;
            }
        }
    }

    function wrapText(text, start, length, prefix, suffix) {
        return text.substring(0, start) + prefix + text.substr(start, length) + suffix + text.substring(start + length);
    }

    for (const token of highlightedTokens) {
        if (!token) {
            // Avoid empty tokens, which might cause an infinite loop.
            continue;
        }

        for (const result of searchResults) {
            // Reset token
            const tokenRegex = new RegExp(utils.escapeRegExp(token), "gi");
            let match;

            // Find all matches
            while ((match = tokenRegex.exec(normalizeString(result.highlightedNotePathTitle))) !== null) {
                result.highlightedNotePathTitle = wrapText(result.highlightedNotePathTitle, match.index, token.length, "{", "}");

                // 2 characters are added, so we need to adjust the index
                tokenRegex.lastIndex += 2;
            }
        }
    }

    for (const result of searchResults) {
        result.highlightedNotePathTitle = result.highlightedNotePathTitle
            .replace(/"/g, "<small>")
            .replace(/'/g, "</small>")
            .replace(/{/g, "<b>")
            .replace(/}/g, "</b>");
    }
}

function formatAttribute(attr) {
    if (attr.type === 'relation') {
        return `~${utils.escapeHtml(attr.name)}=…`;
    }
    else if (attr.type === 'label') {
        let label = `#${utils.escapeHtml(attr.name)}`;

        if (attr.value) {
            const val = /[^\w-]/.test(attr.value) ? `"${attr.value}"` : attr.value;

            label += `=${utils.escapeHtml(val)}`;
        }

        return label;
    }
}

module.exports = {
    searchFromNote,
    searchNotesForAutocomplete,
    findResultsWithQuery,
    findFirstNoteWithQuery,
    searchNotes
};
