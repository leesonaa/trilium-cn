const noteTypes = [
    { type: 'text', defaultMime: 'text/html' },
    { type: 'code', defaultMime: 'text/plain' },
    { type: 'render', defaultMime: '' },
    { type: 'file', defaultMime: 'application/octet-stream' },
    { type: 'image', defaultMime: '' },
    { type: 'search', defaultMime: '' },
    { type: 'relationMap', defaultMime: 'application/json' },
    { type: 'book', defaultMime: '' },
    { type: 'noteMap', defaultMime: '' },
    { type: 'mermaid', defaultMime: 'text/plain' },
    { type: 'canvas', defaultMime: 'application/json' },
    { type: 'webView', defaultMime: '' },
    { type: 'launcher', defaultMime: '' },
    { type: 'doc', defaultMime: '' },
    { type: 'contentWidget', defaultMime: '' }
];

function getDefaultMimeForNoteType(typeName) {
    const typeRec = noteTypes.find(nt => nt.type === typeName);

    if (!typeRec) {
        throw new Error(`Cannot find note type '${typeName}'`);
    }

    return typeRec.defaultMime;
}

module.exports = {
    getNoteTypeNames: () => noteTypes.map(nt => nt.type),
    getDefaultMimeForNoteType
};
