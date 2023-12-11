const becca = require("../becca/becca");
const eu = require("./etapi_utils");
const mappers = require("./mappers");
const attributeService = require("../services/attributes");
const v = require("./validators");

function register(router) {
    eu.route(router, 'get', '/etapi/attributes/:attributeId', (req, res, next) => {
        const attribute = eu.getAndCheckAttribute(req.params.attributeId);

        res.json(mappers.mapAttributeToPojo(attribute));
    });

    const ALLOWED_PROPERTIES_FOR_CREATE_ATTRIBUTE = {
        'attributeId': [v.mandatory, v.notNull, v.isValidEntityId],
        'noteId': [v.mandatory, v.notNull, v.isNoteId],
        'type': [v.mandatory, v.notNull, v.isAttributeType],
        'name': [v.mandatory, v.notNull, v.isString],
        'value': [v.notNull, v.isString],
        'isInheritable': [v.notNull, v.isBoolean],
        'position': [v.notNull, v.isInteger]
    };

    eu.route(router, 'post' ,'/etapi/attributes', (req, res, next) => {
        if (req.body.type === 'relation') {
            eu.getAndCheckNote(req.body.value);
        }

        const params = {};

        eu.validateAndPatch(params, req.body, ALLOWED_PROPERTIES_FOR_CREATE_ATTRIBUTE);

        try {
            const attr = attributeService.createAttribute(params);

            res.status(201).json(mappers.mapAttributeToPojo(attr));
        }
        catch (e) {
            throw new eu.EtapiError(500, eu.GENERIC_CODE, e.message);
        }
    });

    const ALLOWED_PROPERTIES_FOR_PATCH_LABEL = {
        'value': [v.notNull, v.isString],
        'position': [v.notNull, v.isInteger]
    };

    const ALLOWED_PROPERTIES_FOR_PATCH_RELATION = {
        'position': [v.notNull, v.isInteger]
    };

    eu.route(router, 'patch' ,'/etapi/attributes/:attributeId', (req, res, next) => {
        const attribute = eu.getAndCheckAttribute(req.params.attributeId);

        if (attribute.type === 'label') {
            eu.validateAndPatch(attribute, req.body, ALLOWED_PROPERTIES_FOR_PATCH_LABEL);
        } else if (attribute.type === 'relation') {
            eu.getAndCheckNote(req.body.value);

            eu.validateAndPatch(attribute, req.body, ALLOWED_PROPERTIES_FOR_PATCH_RELATION);
        }

        attribute.save();

        res.json(mappers.mapAttributeToPojo(attribute));
    });

    eu.route(router, 'delete' ,'/etapi/attributes/:attributeId', (req, res, next) => {
        const attribute = becca.getAttribute(req.params.attributeId);

        if (!attribute) {
            return res.sendStatus(204);
        }

        attribute.markAsDeleted();

        res.sendStatus(204);
    });
}

module.exports = {
    register
};
