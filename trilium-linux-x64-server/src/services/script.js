const ScriptContext = require('./script_context');
const cls = require('./cls');
const log = require('./log');
const becca = require("../becca/becca");

function executeNote(note, apiParams) {
    if (!note.isJavaScript() || note.getScriptEnv() !== 'backend' || !note.isContentAvailable()) {
        log.info(`Cannot execute note ${note.noteId} "${note.title}", note must be of type "Code: JS backend"`);

        return;
    }

    const bundle = getScriptBundle(note, true, 'backend');

    return executeBundle(bundle, apiParams);
}

function executeNoteNoException(note, apiParams) {
    try {
        executeNote(note, apiParams);
    }
    catch (e) {
        // just swallow, exception is logged already in executeNote
    }
}

function executeBundle(bundle, apiParams = {}) {
    if (!apiParams.startNote) {
        // this is the default case, the only exception is when we want to preserve frontend startNote
        apiParams.startNote = bundle.note;
    }

    const originalComponentId = cls.get('componentId');

    cls.set('componentId', 'script');
    cls.set('bundleNoteId', bundle.note.noteId);

    // last \r\n is necessary if the script contains line comment on its last line
    const script = `function() {\r
${bundle.script}\r
}`;
    const ctx = new ScriptContext(bundle.allNotes, apiParams);

    try {
        return execute(ctx, script);
    }
    catch (e) {
        log.error(`Execution of script "${bundle.note.title}" (${bundle.note.noteId}) failed with error: ${e.message}`);

        throw e;
    }
    finally {
        cls.set('componentId', originalComponentId);
    }
}

/**
 * THIS METHOD CAN'T BE ASYNC, OTHERWISE TRANSACTION WRAPPER WON'T BE EFFECTIVE AND WE WILL BE LOSING THE
 * ENTITY CHANGES IN CLS.
 *
 * This method preserves frontend startNode - that's why we start execution from currentNote and override
 * bundle's startNote.
 */
function executeScript(script, params, startNoteId, currentNoteId, originEntityName, originEntityId) {
    const startNote = becca.getNote(startNoteId);
    const currentNote = becca.getNote(currentNoteId);
    const originEntity = becca.getEntity(originEntityName, originEntityId);

    // we're just executing an excerpt of the original frontend script in the backend context, so we must
    // override normal note's content, and it's mime type / script environment
    const overrideContent = `return (${script}\r\n)(${getParams(params)})`;

    const bundle = getScriptBundle(currentNote, true, 'backend', [], overrideContent);

    return executeBundle(bundle, { startNote, originEntity });
}

function execute(ctx, script) {
    return function() { return eval(`const apiContext = this;\r\n(${script}\r\n)()`); }.call(ctx);
}

function getParams(params) {
    if (!params) {
        return params;
    }

    return params.map(p => {
        if (typeof p === "string" && p.startsWith("!@#Function: ")) {
            return p.substr(13);
        }
        else {
            return JSON.stringify(p);
        }
    }).join(",");
}

/**
 * @param {BNote} note
 * @param {string} [script]
 * @param {Array} [params]
 */
function getScriptBundleForFrontend(note, script, params) {
    let overrideContent = null;

    if (script) {
        overrideContent = `return (${script}\r\n)(${getParams(params)})`;
    }

    const bundle = getScriptBundle(note, true, 'frontend', [], overrideContent);

    if (!bundle) {
        return;
    }

    // for frontend, we return just noteIds because frontend needs to use its own entity instances
    bundle.noteId = bundle.note.noteId;
    delete bundle.note;

    bundle.allNoteIds = bundle.allNotes.map(note => note.noteId);
    delete bundle.allNotes;

    return bundle;
}

/**
 * @param {BNote} note
 * @param {boolean} [root=true]
 * @param {string|null} [scriptEnv]
 * @param {string[]} [includedNoteIds]
 * @param {string|null} [overrideContent]
 */
function getScriptBundle(note, root = true, scriptEnv = null, includedNoteIds = [], overrideContent = null) {
    if (!note.isContentAvailable()) {
        return;
    }

    if (!note.isJavaScript() && !note.isHtml()) {
        return;
    }

    if (!root && note.hasOwnedLabel('disableInclusion')) {
        return;
    }

    if (note.type !== 'file' && !root && scriptEnv !== note.getScriptEnv()) {
        return;
    }

    const bundle = {
        note: note,
        script: '',
        html: '',
        allNotes: [note]
    };

    if (includedNoteIds.includes(note.noteId)) {
        return bundle;
    }

    includedNoteIds.push(note.noteId);

    const modules = [];

    for (const child of note.getChildNotes()) {
        const childBundle = getScriptBundle(child, false, scriptEnv, includedNoteIds);

        if (childBundle) {
            modules.push(childBundle.note);
            bundle.script += childBundle.script;
            bundle.html += childBundle.html;
            bundle.allNotes = bundle.allNotes.concat(childBundle.allNotes);
        }
    }

    const moduleNoteIds = modules.map(mod => mod.noteId);

    // only frontend scripts are async. Backend cannot be async because of transaction management.
    const isFrontend = scriptEnv === 'frontend';

    if (note.isJavaScript()) {
        bundle.script += `
apiContext.modules['${note.noteId}'] = { exports: {} };
${root ? 'return ' : ''}${isFrontend ? 'await' : ''} ((${isFrontend ? 'async' : ''} function(exports, module, require, api${modules.length > 0 ? ', ' : ''}${modules.map(child => sanitizeVariableName(child.title)).join(', ')}) {
try {
${overrideContent || note.getContent()};
} catch (e) { throw new Error("Load of script note \\"${note.title}\\" (${note.noteId}) failed with: " + e.message); }
for (const exportKey in exports) module.exports[exportKey] = exports[exportKey];
return module.exports;
}).call({}, {}, apiContext.modules['${note.noteId}'], apiContext.require(${JSON.stringify(moduleNoteIds)}), apiContext.apis['${note.noteId}']${modules.length > 0 ? ', ' : ''}${modules.map(mod => `apiContext.modules['${mod.noteId}'].exports`).join(', ')}));
`;
    }
    else if (note.isHtml()) {
        bundle.html += note.getContent();
    }

    return bundle;
}

function sanitizeVariableName(str) {
    return str.replace(/[^a-z0-9_]/gim, "");
}

module.exports = {
    executeNote,
    executeNoteNoException,
    executeScript,
    getScriptBundleForFrontend
};
