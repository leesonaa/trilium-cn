"use strict";

const optionService = require('./options');
const log = require('./log');
const utils = require('./utils');

const isMac = process.platform === "darwin";
const isElectron = utils.isElectron();

/**
 * Scope here means on which element the keyboard shortcuts are attached - this means that for the shortcut to work,
 * the focus has to be inside the element.
 *
 * So e.g. shortcuts with "note-tree" scope work only when the focus is in note tree.
 * This allows to have the same shortcut have different actions attached based on the context
 * e.g. CTRL-C in note tree does something a bit different from CTRL-C in the text editor.
 */

const DEFAULT_KEYBOARD_ACTIONS = [
    {
        separator: "笔记导航"
    },
    {
        actionName: "backInNoteHistory",
        // Mac has a different history navigation shortcuts - https://github.com/zadam/trilium/issues/376
        defaultShortcuts: isMac ? ["CommandOrControl+Left"] : ["Alt+Left"],
        scope: "window"
    },
    {
        actionName: "forwardInNoteHistory",
        // Mac has a different history navigation shortcuts - https://github.com/zadam/trilium/issues/376
        defaultShortcuts: isMac ? ["CommandOrControl+Right"] : ["Alt+Right"],
        scope: "window"
    },
    {
        actionName: "jumpToNote",
        defaultShortcuts: ["CommandOrControl+J"],
        description: '打开跳转到笔记对话框',
        scope: "window"
    },
    {
        actionName: "scrollToActiveNote",
        defaultShortcuts: ["CommandOrControl+."],
        scope: "window"
    },
    {
        actionName: "quickSearch",
        defaultShortcuts: ["CommandOrControl+S"],
        scope: "window"
    },
    {
        actionName: "searchInSubtree",
        defaultShortcuts: ["CommandOrControl+Shift+S"],
        description: "在活动笔记的子树中搜索笔记",
        scope: "note-tree"
    },
    {
        actionName: "expandSubtree",
        defaultShortcuts: [],
        description: "展开当前笔记的子树",
        scope: "note-tree"
    },
    {
        actionName: "collapseTree",
        defaultShortcuts: ["Alt+C"],
        description: "折叠完整的笔记树",
        scope: "window"
    },
    {
        actionName: "collapseSubtree",
        defaultShortcuts: ["Alt+-"],
        description: "折叠当前笔记的子树",
        scope: "note-tree"
    },
    {
        actionName: "sortChildNotes",
        defaultShortcuts: ["Alt+S"],
        description: "对子笔记进行排序",
        scope: "note-tree"
    },


    {
        separator: "创建和移动笔记"
    },
    {
        actionName: "createNoteAfter",
        defaultShortcuts: ["CommandOrControl+O"],
        scope: "window"
    },
    {
        actionName: "createNoteInto",
        defaultShortcuts: ["CommandOrControl+P"],
        scope: "window"
    },
    {
        actionName: "createNoteIntoInbox",
        defaultShortcuts: ["global:CommandOrControl+Alt+P"],
        description: "在收件箱(如果已定义)或笔记中创建并打开",
        scope: "window"
    },
    {
        actionName: "deleteNotes",
        defaultShortcuts: ["Delete"],
        description: "删除笔记",
        scope: "note-tree"
    },
    {
        actionName: "moveNoteUp",
        defaultShortcuts: isMac ? ["Alt+Up"] : ["CommandOrControl+Up"],
        description: "上移笔记",
        scope: "note-tree"
    },
    {
        actionName: "moveNoteDown",
        defaultShortcuts: isMac ? ["Alt+Down"] : ["CommandOrControl+Down"],
        description: "下移笔记",
        scope: "note-tree"
    },
    {
        actionName: "moveNoteUpInHierarchy",
        defaultShortcuts: isMac ? ["Alt+Left"] : ["CommandOrControl+Left"],
        description: "在层次结构中上移笔记",
        scope: "note-tree"
    },
    {
        actionName: "moveNoteDownInHierarchy",
        defaultShortcuts: isMac ? ["Alt+Right"] : ["CommandOrControl+Right"],
        description: "在层次结构中下移笔记",
        scope: "note-tree"
    },
    {
        actionName: "editNoteTitle",
        defaultShortcuts: ["Enter"],
        description: "从树跳到笔记详情并编辑标题",
        scope: "note-tree"
    },
    {
        actionName: "editBranchPrefix",
        defaultShortcuts: ["F2"],
        description: "显示编辑分支前缀对话框",
        scope: "window"
    },
    {
        actionName: "cloneNotesTo",
        defaultShortcuts: ["CommandOrControl+Shift+C"],
        scope: "window"
    },
    {
        actionName: "moveNotesTo",
        defaultShortcuts: ["CommandOrControl+Shift+X"],
        scope: "window"
    },

    {
        separator: "笔记剪贴板"
    },


    {
        actionName: "copyNotesToClipboard",
        defaultShortcuts: ["CommandOrControl+C"],
        description: "将选定的笔记复制到剪贴板",
        scope: "note-tree"
    },
    {
        actionName: "pasteNotesFromClipboard",
        defaultShortcuts: ["CommandOrControl+V"],
        description: "将剪贴板中的笔记粘贴到活动笔记中",
        scope: "note-tree"
    },
    {
        actionName: "cutNotesToClipboard",
        defaultShortcuts: ["CommandOrControl+X"],
        description: "将选定的笔记剪切到剪贴板",
        scope: "note-tree"
    },
    {
        actionName: "selectAllNotesInParent",
        defaultShortcuts: ["CommandOrControl+A"],
        description: "从当前笔记级别中选择所有笔记",
        scope: "note-tree"
    },
    {
        actionName: "addNoteAboveToSelection",
        defaultShortcuts: ["Shift+Up"],
        description: "将以上笔记添加到选择中",
        scope: "note-tree"
    },
    {
        actionName: "addNoteBelowToSelection",
        defaultShortcuts: ["Shift+Down"],
        description: "将以上笔记添加到选择中",
        scope: "note-tree"
    },
    {
        actionName: "duplicateSubtree",
        defaultShortcuts: [],
        description: "创建子树副本",
        scope: "note-tree"
    },


    {
        separator: "标签页和窗口"
    },
    {
        actionName: "openNewTab",
        defaultShortcuts: isElectron ? ["CommandOrControl+T"] : [],
        description: "开启新标签页",
        scope: "window"
    },
    {
        actionName: "closeActiveTab",
        defaultShortcuts: isElectron ? ["CommandOrControl+W"] : [],
        description: "关闭活动标签",
        scope: "window"
    },
    {
        actionName: "reopenLastTab",
        defaultShortcuts: isElectron ? ["CommandOrControl+Shift+T"] : [],
        description: "重新打开关闭的标签",
        scope: "window"
    },
    {
        actionName: "activateNextTab",
        defaultShortcuts: isElectron ? ["CommandOrControl+Tab", "CommandOrControl+PageDown"] : [],
        description: "激活右侧的标签页",
        scope: "window"
    },
    {
        actionName: "activatePreviousTab",
        defaultShortcuts: isElectron ? ["CommandOrControl+Shift+Tab", "CommandOrControl+PageUp"] : [],
        description: "激活左侧的标签页",
        scope: "window"
    },
    {
        actionName: "openNewWindow",
        defaultShortcuts: [],
        description: "开启新的空白窗口",
        scope: "window"
    },
    {
        actionName: "toggleTray",
        defaultShortcuts: [],
        description: "Shows/hides the application from the system tray",
        scope: "window"
    },
    {
        actionName: "firstTab",
        defaultShortcuts: ["CommandOrControl+1"],
        description: "Activates the first tab in the list",
        scope: "window"
    },
    {
        actionName: "secondTab",
        defaultShortcuts: ["CommandOrControl+2"],
        description: "Activates the second tab in the list",
        scope: "window"
    },
    {
        actionName: "thirdTab",
        defaultShortcuts: ["CommandOrControl+3"],
        description: "Activates the third tab in the list",
        scope: "window"
    },
    {
        actionName: "fourthTab",
        defaultShortcuts: ["CommandOrControl+4"],
        description: "Activates the fourth tab in the list",
        scope: "window"
    },
    {
        actionName: "fifthTab",
        defaultShortcuts: ["CommandOrControl+5"],
        description: "Activates the fifth tab in the list",
        scope: "window"
    },
    {
        actionName: "sixthTab",
        defaultShortcuts: ["CommandOrControl+6"],
        description: "Activates the sixth tab in the list",
        scope: "window"
    },
    {
        actionName: "seventhTab",
        defaultShortcuts: ["CommandOrControl+7"],
        description: "Activates the seventh tab in the list",
        scope: "window"
    },
    {
        actionName: "eigthTab",
        defaultShortcuts: ["CommandOrControl+8"],
        description: "Activates the eigth tab in the list",
        scope: "window"
    },
    {
        actionName: "ninthTab",
        defaultShortcuts: ["CommandOrControl+9"],
        description: "Activates the ninth tab in the list",
        scope: "window"
    },
    {
        actionName: "lastTab",
        defaultShortcuts: ["CommandOrControl+0"],
        description: "Activates the last tab in the list",
        scope: "window"
    },


    {
        separator: "对话框"
    },
    {
        actionName: "showNoteSource",
        defaultShortcuts: [],
        description: "显示笔记源代码对话框",
        scope: "window"
    },
    {
        actionName: "showOptions",
        defaultShortcuts: [],
        description: "显示选项对话框",
        scope: "window"
    },
    {
        actionName: "showRevisions",
        defaultShortcuts: [],
        description: "显示笔记历史对话框",
        scope: "window"
    },
    {
        actionName: "showRecentChanges",
        defaultShortcuts: [],
        description: "显示最近的修改对话框",
        scope: "window"
    },
    {
        actionName: "showSQLConsole",
        defaultShortcuts: ["Alt+O"],
        description: "显示SQL控制台对话框",
        scope: "window"
    },
    {
        actionName: "showBackendLog",
        defaultShortcuts: [],
        description: "显示后端日志对话框",
        scope: "window"
    },
    {
        actionName: "showHelp",
        defaultShortcuts: ["F1"],
        description: "显示内置的帮助/备忘单",
        scope: "window"
    },


    {
        separator: "文字笔记操作"
    },

    {
        actionName: "addLinkToText",
        defaultShortcuts: ["CommandOrControl+L"],
        description: "打开对话框以将链接添加到文本",
        scope: "text-detail"
    },
    {
        actionName: "followLinkUnderCursor",
        defaultShortcuts: ["CommandOrControl+Enter"],
        description: "跟随脱字符^所在的链接",
        scope: "text-detail"
    },
    {
        actionName: "insertDateTimeToText",
        defaultShortcuts: ["Alt+T"],
        description: "插入当前的日期和时间",
        scope: "text-detail"
    },
    {
        actionName: "pasteMarkdownIntoText",
        defaultShortcuts: [],
        description: "将Markdown从剪贴板粘贴到文本笔记中",
        scope: "text-detail"
    },
    {
        actionName: "cutIntoNote",
        defaultShortcuts: [],
        description: "从当前笔记中剪切选择内容, 并使用所选文本创建子笔记",
        scope: "text-detail"
    },
    {
        actionName: "addIncludeNoteToText",
        defaultShortcuts: [],
        description: "打开对话框以包含笔记",
        scope: "text-detail"
    },
    {
        actionName: "editReadOnlyNote",
        defaultShortcuts: [],
        description: "编辑只读笔记",
        scope: "window"
    },

    {
        separator: "属性(标签和关系)"
    },

    {
        actionName: "addNewLabel",
        defaultShortcuts: ["Alt+L"],
        description: "建立新标签",
        scope: "window"
    },
    {
        actionName: "addNewRelation",
        defaultShortcuts: ["Alt+R"],
        description: "建立新关系",
        scope: "window"
    },

    {
        separator: "Ribbon 标签"
    },

    {
        actionName: "toggleRibbonTabBasicProperties",
        defaultShortcuts: [],
        description: "切换基本属性",
        scope: "window"
    },
    {
        actionName: "toggleRibbonTabBookProperties",
        defaultShortcuts: [],
        description: "切换书属性",
        scope: "window"
    },
    {
        actionName: "toggleRibbonTabFileProperties",
        defaultShortcuts: [],
        description: "切换文件属性",
        scope: "window"
    },
    {
        actionName: "toggleRibbonTabImageProperties",
        defaultShortcuts: [],
        description: "切换图像属性",
        scope: "window"
    },
    {
        actionName: "toggleRibbonTabOwnedAttributes",
        defaultShortcuts: ["Alt+A"],
        description: "切换拥有的属性",
        scope: "window"
    },
    {
        actionName: "toggleRibbonTabInheritedAttributes",
        defaultShortcuts: [],
        description: "切换继承的属性",
        scope: "window"
    },
    {
        actionName: "toggleRibbonTabPromotedAttributes",
        defaultShortcuts: [],
        description: "切换升级的属性",
        scope: "window"
    },
    {
        actionName: "toggleRibbonTabNoteMap",
        defaultShortcuts: [],
        description: "切换链接地图",
        scope: "window"
    },
    {
        actionName: "toggleRibbonTabNoteInfo",
        defaultShortcuts: [],
        description: "切换笔记信息",
        scope: "window"
    },
    {
        actionName: "toggleRibbonTabNotePaths",
        defaultShortcuts: [],
        description: "切换笔记路径",
        scope: "window"
    },
    {
        actionName: "toggleRibbonTabSimilarNotes",
        defaultShortcuts: [],
        description: "切换相似笔记",
        scope: "window"
    },

    {
        separator: "其他"
    },

    {
        actionName: "printActiveNote",
        defaultShortcuts: [],
        scope: "window"
    },
    {
        actionName: "openNoteExternally",
        defaultShortcuts: [],
        description: "使用默认应用程序打开笔记",
        scope: "window"
    },
    {
        actionName: "renderActiveNote",
        defaultShortcuts: [],
        description: "渲染(重新渲染)活动笔记",
        scope: "window"
    },
    {
        actionName: "runActiveNote",
        defaultShortcuts: ["CommandOrControl+Enter"],
        description: "运行活动的JavaScript(前端/后端)代码笔记",
        scope: "code-detail"
    },
    {
        actionName: "toggleNoteHoisting",
        defaultShortcuts: ["Alt+H"],
        description: "切换活动笔记的笔记提升",
        scope: "window"
    },
    {
        actionName: "unhoist",
        defaultShortcuts: ["Alt+U"],
        description: "从任何地方取消提升",
        scope: "window"
    },
    {
        actionName: "reloadFrontendApp",
        defaultShortcuts: ["F5", "CommandOrControl+R"],
        description: "重新加载前端应用",
        scope: "window"
    },
    {
        actionName: "openDevTools",
        defaultShortcuts: isElectron ? ["CommandOrControl+Shift+I"] : [],
        description: "打开开发者工具",
        scope: "window"
    },
    {
        actionName: "findInText",
        defaultShortcuts: isElectron ? ["CommandOrControl+F"] : [],
        scope: "window"
    },
    {
        actionName: "toggleLeftPane",
        defaultShortcuts: [],
        description: "切换左(笔记树)面板",
        scope: "window"
    },
    {
        actionName: "toggleFullscreen",
        defaultShortcuts: ["F11"],
        description: "切换全屏",
        scope: "window"
    },
    {
        actionName: "zoomOut",
        defaultShortcuts: isElectron ? ["CommandOrControl+-"] : [],
        description: "缩小",
        scope: "window"
    },
    {
        actionName: "zoomIn",
        description: "放大",
        defaultShortcuts: isElectron ? ["CommandOrControl+="] : [],
        scope: "window"
    },
    {
        actionName: "zoomReset",
        description: "Reset zoom level",
        defaultShortcuts: isElectron ? ["CommandOrControl+0"] : [],
        scope: "window"
    },
    {
        actionName: "copyWithoutFormatting",
        defaultShortcuts: ["CommandOrControl+Alt+C"],
        description: "复制所选文本而不设置格式",
        scope: "text-detail"
    },
    {
        actionName: "forceSaveRevision",
        defaultShortcuts: [],
        description: "强制保存当前笔记/创建笔记历史记录",
        scope: "window"
    }
];

const platformModifier = isMac ? 'Meta' : 'Ctrl';

for (const action of DEFAULT_KEYBOARD_ACTIONS) {
    if (action.defaultShortcuts) {
        action.defaultShortcuts = action.defaultShortcuts.map(shortcut => shortcut.replace("CommandOrControl", platformModifier));
    }
}

function getKeyboardActions() {
    const actions = JSON.parse(JSON.stringify(DEFAULT_KEYBOARD_ACTIONS));

    for (const action of actions) {
        action.effectiveShortcuts = action.effectiveShortcuts ? action.defaultShortcuts.slice() : [];
    }

    for (const option of optionService.getOptions()) {
        if (option.name.startsWith('keyboardShortcuts')) {
            let actionName = option.name.substr(17);
            actionName = actionName.charAt(0).toLowerCase() + actionName.slice(1);

            const action = actions.find(ea => ea.actionName === actionName);

            if (action) {
                try {
                    action.effectiveShortcuts = JSON.parse(option.value);
                }
                catch (e) {
                    log.error(`Could not parse shortcuts for action ${actionName}`);
                }
            }
            else {
                log.info(`Keyboard action ${actionName} found in database, but not in action definition.`);
            }
        }
    }

    return actions;
}

module.exports = {
    DEFAULT_KEYBOARD_ACTIONS,
    getKeyboardActions
};
