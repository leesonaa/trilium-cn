const sax = require("sax");
const stream = require('stream');
const {Throttle} = require('stream-throttle');
const log = require("../log");
const utils = require("../utils");
const sql = require("../sql");
const noteService = require("../notes");
const imageService = require("../image");
const protectedSessionService = require('../protected_session');
const htmlSanitizer = require("../html_sanitizer");
const {sanitizeAttributeName} = require("../sanitize_attribute_name");

/**
 * date format is e.g. 20181121T193703Z or 2013-04-14T16:19:00.000Z (Mac evernote, see #3496)
 * @returns trilium date format, e.g. 2013-04-14 16:19:00.000Z
 */
function parseDate(text) {
    // convert ISO format to the "20181121T193703Z" format
    text = text.replace(/[-:]/g, "");

    // insert - and : to convert it to trilium format
    text = text.substr(0, 4) + "-" + text.substr(4, 2) + "-" + text.substr(6, 2)
        + " " + text.substr(9, 2) + ":" + text.substr(11, 2) + ":" + text.substr(13, 2) + ".000Z";

    return text;
}

let note = {};
let resource;

function importEnex(taskContext, file, parentNote) {
    const saxStream = sax.createStream(true);

    const rootNoteTitle = file.originalname.toLowerCase().endsWith(".enex")
        ? file.originalname.substr(0, file.originalname.length - 5)
        : file.originalname;

    // root note is new note into all ENEX/notebook's notes will be imported
    const rootNote = noteService.createNewNote({
        parentNoteId: parentNote.noteId,
        title: rootNoteTitle,
        content: "",
        type: 'text',
        mime: 'text/html',
        isProtected: parentNote.isProtected && protectedSessionService.isProtectedSessionAvailable(),
    }).note;

    function extractContent(content) {
        const openingNoteIndex = content.indexOf('<en-note>');

        if (openingNoteIndex !== -1) {
            content = content.substr(openingNoteIndex + 9);
        }

        const closingNoteIndex = content.lastIndexOf('</en-note>');

        if (closingNoteIndex !== -1) {
            content = content.substr(0, closingNoteIndex);
        }

        content = content.trim();

        // workaround for https://github.com/ckeditor/ckeditor5-list/issues/116
        content = content.replace(/<li>\s*<div>/g, "<li>");
        content = content.replace(/<\/div>\s*<\/li>/g, "</li>");

        // workaround for https://github.com/ckeditor/ckeditor5-list/issues/115
        content = content.replace(/<ul>\s*<ul>/g, "<ul><li><ul>");
        content = content.replace(/<\/li>\s*<ul>/g, "<ul>");
        content = content.replace(/<\/ul>\s*<\/ul>/g, "</ul></li></ul>");
        content = content.replace(/<\/ul>\s*<li>/g, "</ul></li><li>");

        content = content.replace(/<ol>\s*<ol>/g, "<ol><li><ol>");
        content = content.replace(/<\/li>\s*<ol>/g, "<ol>");
        content = content.replace(/<\/ol>\s*<\/ol>/g, "</ol></li></ol>");
        content = content.replace(/<\/ol>\s*<li>/g, "</ol></li><li>");

        // Replace en-todo with unicode ballot box
        content = content.replace(/<en-todo\s+checked="true"\s*\/>/g, "\u2611 ");
        content = content.replace(/<en-todo(\s+checked="false")?\s*\/>/g, "\u2610 ");

        // Replace OneNote converted checkboxes with unicode ballot box based
        // on known hash of checkboxes for regular, p1, and p2 checkboxes
        content = content.replace(/<en-media alt="To Do( priority [12])?" hash="(74de5d3d1286f01bac98d32a09f601d9|4a19d3041585e11643e808d68dd3e72f|8e17580123099ac6515c3634b1f6f9a1)"( type="[a-z\/]*"| width="\d+"| height="\d+")*\/>/g, "\u2610 ");
        content = content.replace(/<en-media alt="To Do( priority [12])?" hash="(5069b775461e471a47ce04ace6e1c6ae|7912ee9cec35fc3dba49edb63a9ed158|3a05f4f006a6eaf2627dae5ed8b8013b)"( type="[a-z\/]*"| width="\d+"| height="\d+")*\/>/g, "\u2611 ");

        content = htmlSanitizer.sanitize(content);

        return content;
    }


    const path = [];

    function getCurrentTag() {
        if (path.length >= 1) {
            return path[path.length - 1];
        }
    }

    function getPreviousTag() {
        if (path.length >= 2) {
            return path[path.length - 2];
        }
    }

    saxStream.on("error", e => {
        // unhandled errors will throw, since this is a proper node event emitter.
        log.error(`error when parsing ENEX file: ${e}`);
        // clear the error
        this._parser.error = null;
        this._parser.resume();
    });

    saxStream.on("text", text => {
        const currentTag = getCurrentTag();
        const previousTag = getPreviousTag();

        if (previousTag === 'note-attributes') {
            let labelName = currentTag;

            if (labelName === 'source-url') {
                labelName = 'pageUrl';
            }

            labelName = sanitizeAttributeName(labelName);

            note.attributes.push({
                type: 'label',
                name: labelName,
                value: text
            });
        }
        else if (previousTag === 'resource-attributes') {
            if (currentTag === 'file-name') {
                resource.attributes.push({
                    type: 'label',
                    name: 'originalFileName',
                    value: text
                });

                resource.title = text;
            }
            else if (currentTag === 'source-url') {
                resource.attributes.push({
                    type: 'label',
                    name: 'pageUrl',
                    value: text
                });
            }
        }
        else if (previousTag === 'resource') {
            if (currentTag === 'data') {
                text = text.replace(/\s/g, '');

                // resource can be chunked into multiple events: https://github.com/zadam/trilium/issues/3424
                // it would probably make sense to do this in a more global way since it can in theory affect any field,
                // not just data
                resource.content = (resource.content || "") + text;
            }
            else if (currentTag === 'mime') {
                resource.mime = text.toLowerCase();
            }
        }
        else if (previousTag === 'note') {
            if (currentTag === 'title') {
                note.title = text;
            } else if (currentTag === 'created') {
                note.utcDateCreated = parseDate(text);
            } else if (currentTag === 'updated') {
                note.utcDateModified = parseDate(text);
            } else if (currentTag === 'tag') {
                note.attributes.push({
                    type: 'label',
                    name: sanitizeAttributeName(text),
                    value: ''
                })
            }
            // unknown tags are just ignored
        }
    });

    saxStream.on("attribute", attr => {
        // an attribute.  attr has "name" and "value"
    });

    saxStream.on("opentag", tag => {
        path.push(tag.name);

        if (tag.name === 'note') {
            note = {
                content: "",
                // it's an array, not a key-value object because we don't know if attributes can be duplicated
                attributes: [],
                resources: []
            };
        }
        else if (tag.name === 'resource') {
            resource = {
                title: "资源",
                attributes: []
            };

            note.resources.push(resource);
        }
    });

    function updateDates(note, utcDateCreated, utcDateModified) {
        // it's difficult to force custom dateCreated and dateModified to Note entity, so we do it post-creation with SQL
        sql.execute(`
                UPDATE notes 
                SET dateCreated = ?, 
                    utcDateCreated = ?,
                    dateModified = ?,
                    utcDateModified = ?
                WHERE noteId = ?`,
            [utcDateCreated, utcDateCreated, utcDateModified, utcDateModified, note.noteId]);

        sql.execute(`
                UPDATE blobs
                SET utcDateModified = ?
                WHERE blobId = ?`,
            [utcDateModified, note.blobId]);
    }

    function saveNote() {
        // make a copy because stream continues with the next call and note gets overwritten
        let {title, content, attributes, resources, utcDateCreated, utcDateModified} = note;

        content = extractContent(content);

        const noteEntity = noteService.createNewNote({
            parentNoteId: rootNote.noteId,
            title,
            content,
            utcDateCreated,
            type: 'text',
            mime: 'text/html',
            isProtected: parentNote.isProtected && protectedSessionService.isProtectedSessionAvailable(),
        }).note;

        for (const attr of attributes) {
            noteEntity.addAttribute(attr.type, attr.name, attr.value);
        }

        utcDateCreated = utcDateCreated || noteEntity.utcDateCreated;
        // sometime date modified is not present in ENEX, then use date created
        utcDateModified = utcDateModified || utcDateCreated;

        taskContext.increaseProgressCount();

        for (const resource of resources) {
            if (!resource.content) {
                continue;
            }

            resource.content = utils.fromBase64(resource.content);

            const hash = utils.md5(resource.content);

            // skip all checked/unchecked checkboxes from OneNote
            if (['74de5d3d1286f01bac98d32a09f601d9',
                '4a19d3041585e11643e808d68dd3e72f',
                '8e17580123099ac6515c3634b1f6f9a1',
                '5069b775461e471a47ce04ace6e1c6ae',
                '7912ee9cec35fc3dba49edb63a9ed158',
                '3a05f4f006a6eaf2627dae5ed8b8013b'].includes(hash)) {
                continue;
            }

            const mediaRegex = new RegExp(`<en-media [^>]*hash="${hash}"[^>]*>`, 'g');

            resource.mime = resource.mime || "application/octet-stream";

            const createFileNote = () => {
                const resourceNote = noteService.createNewNote({
                    parentNoteId: noteEntity.noteId,
                    title: resource.title,
                    content: resource.content,
                    type: 'file',
                    mime: resource.mime,
                    isProtected: parentNote.isProtected && protectedSessionService.isProtectedSessionAvailable(),
                }).note;

                for (const attr of resource.attributes) {
                    resourceNote.addAttribute(attr.type, attr.name, attr.value);
                }

                updateDates(resourceNote, utcDateCreated, utcDateModified);

                taskContext.increaseProgressCount();

                const resourceLink = `<a href="#root/${resourceNote.noteId}">${utils.escapeHtml(resource.title)}</a>`;

                content = content.replace(mediaRegex, resourceLink);
            };

            if (resource.mime && resource.mime.startsWith('image/')) {
                try {
                    const originalName = (resource.title && resource.title !== 'resource')
                        ? resource.title
                        : `image.${resource.mime.substr(6)}`; // default if real name is not present

                    const attachment = imageService.saveImageToAttachment(noteEntity.noteId, resource.content, originalName, taskContext.data.shrinkImages);

                    const encodedTitle = encodeURIComponent(attachment.title);
                    const url = `api/attachments/${attachment.attachmentId}/image/${encodedTitle}`;
                    const imageLink = `<img src="${url}">`;

                    content = content.replace(mediaRegex, imageLink);

                    if (!content.includes(imageLink)) {
                        // if there wasn't any match for the reference, we'll add the image anyway,
                        // otherwise the image would be removed since no note would include it
                        content += imageLink;
                    }
                } catch (e) {
                    log.error(`error when saving image from ENEX file: ${e.message}`);
                    createFileNote();
                }
            } else {
                createFileNote();
            }
        }

        content = htmlSanitizer.sanitize(content);

        // save updated content with links to files/images
        noteEntity.setContent(content);

        noteService.asyncPostProcessContent(noteEntity, content);

        updateDates(noteEntity, utcDateCreated, utcDateModified);
    }

    saxStream.on("closetag", tag => {
        path.pop();

        if (tag === 'note') {
            saveNote();
        }
    });

    saxStream.on("opencdata", () => {
        //console.log("opencdata");
    });

    saxStream.on("cdata", text => {
        note.content += text;
    });

    saxStream.on("closecdata", () => {
        //console.log("closecdata");
    });

    return new Promise((resolve, reject) =>
    {
        // resolve only when we parse the whole document AND saving of all notes have been finished
        saxStream.on("end", () => resolve(rootNote));

        const bufferStream = new stream.PassThrough();
        bufferStream.end(file.buffer);

        bufferStream
            // rate limiting to improve responsiveness during / after import
            .pipe(new Throttle({rate: 500000}))
            .pipe(saxStream);
    });
}

module.exports = { importEnex };
