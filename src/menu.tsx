/*
 * This file is part of Cockpit.
 *
 * Copyright (C) 2017 Red Hat, Inc.
 *
 * Cockpit is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or
 * (at your option) any later version.
 *
 * Cockpit is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Cockpit; If not, see <http://www.gnu.org/licenses/>.
 */

import React from "react";

import { AlertVariant } from "@patternfly/react-core/dist/esm/components/Alert";

import cockpit from "cockpit";
import type { FileInfo } from "cockpit/fsinfo";
import { basename, dirname } from "cockpit-path";
import type { Dialogs } from 'dialogs';

import type { FolderFileInfo } from "./app";
import { show_create_file_dialog } from './dialogs/create-file.tsx';
import { confirm_delete } from './dialogs/delete.tsx';
import { edit_file, MAX_EDITOR_FILE_SIZE } from './dialogs/editor.tsx';
import { show_create_directory_dialog } from './dialogs/mkdir.tsx';
import { edit_permissions } from './dialogs/permissions.jsx';
import { show_rename_dialog } from './dialogs/rename.tsx';
import { downloadFile } from './download.tsx';

const _ = cockpit.gettext;

type MenuItem = { type: "divider" } | {
    type?: never,
    title: string,
    id: string,
    onClick: () => void;
    isDisabled?: boolean;
    className?: string;
};

export function pasteFromClipboard(
    clipboard: string[],
    cwdInfo: FileInfo | null,
    path: string,
    addAlert: (title: string, variant: AlertVariant, key: string, detail?: string) => void,
) {
    const existingFiles = clipboard.filter(sourcePath => cwdInfo?.entries?.[basename(sourcePath)]);
    if (existingFiles.length > 0) {
        addAlert(_("Pasting failed"), AlertVariant.danger, "paste-error",
                 cockpit.format(_("\"$0\" exists, not overwriting with paste."),
                                existingFiles.map(basename).join(", ")));
        return;
    }
    cockpit.spawn([
        "cp",
        "-R",
        ...clipboard,
        path
    ]).catch(err => addAlert(err.message, AlertVariant.danger, `${new Date().getTime()}`));
}

export function get_menu_items(
    path: string,
    selected: FolderFileInfo[], setSelected: React.Dispatch<React.SetStateAction<FolderFileInfo[]>>,
    clipboard: string[], setClipboard: React.Dispatch<React.SetStateAction<string[]>>,
    cwdInfo: FileInfo | null,
    addAlert: (title: string, variant: AlertVariant, key: string, detail?: string) => void,
    dialogs: Dialogs,
) {
    const menuItems: MenuItem[] = [];
    // @ts-expect-error: complains about terminal not existing as a property despite being json
    const supportsTerminal = cockpit.manifests.system?.tools?.terminal?.capabilities?.includes("path");

    if (selected.length === 0) {
        // HACK: basename('/') is currently ""
        const current_directory = { ...cwdInfo, name: basename(path) || "/", category: null, to: null };
        const base_path = get_base_path(path);
        menuItems.push(
            {
                id: "paste-item",
                title: _("Paste"),
                isDisabled: clipboard.length === 0,
                onClick: () => pasteFromClipboard(clipboard, cwdInfo, path, addAlert),
            },
            { type: "divider" },
            {
                id: "create-folder",
                title: _("Create directory"),
                onClick: () => show_create_directory_dialog(dialogs, path)
            },
            {
                id: "create-file",
                title: _("Create file"),
                onClick: () => show_create_file_dialog(dialogs, path, addAlert)
            },
            { type: "divider" },
            {
                id: "edit-permissions",
                title: _("Edit permissions"),
                onClick: () => edit_permissions(dialogs, current_directory, base_path)
            }
        );
        if (supportsTerminal) {
            menuItems.push(
                { type: "divider" },
                {
                    id: "terminal",
                    title: _("Open in terminal"),
                    onClick: () => cockpit.jump("/system/terminal#/?path=" + encodeURIComponent(path))
                }
            );
        }
    } else if (selected.length === 1) {
        const item = selected[0];
        // Only allow code, text and unknown file types as we detect things by
        // extensions, so not allowing unknown file types would disallow one
        // from editing for example /etc/hostname
        const allowed_edit_types = ["code-file", "text-file", "file"];
        if (item.type === 'reg' &&
            allowed_edit_types.includes(item?.category?.class || "") &&
            item.size !== undefined && item.size < MAX_EDITOR_FILE_SIZE)
            menuItems.push(
                {
                    id: "open-file",
                    title: _("Open text file"),
                    onClick: () => edit_file(dialogs, path + item.name)
                },
                { type: "divider" },
            );
        menuItems.push(
            {
                id: "copy-item",
                title: _("Copy"),
                onClick: () => setClipboard([path + item.name])
            },
            { type: "divider" },
            {
                id: "edit-permissions",
                title: _("Edit permissions"),
                onClick: () => edit_permissions(dialogs, item, path)
            },
            {
                id: "rename-item",
                title: _("Rename"),
                onClick: () => show_rename_dialog(dialogs, path, item)
            },
            { type: "divider" },
            {
                id: "delete-item",
                title: _("Delete"),
                className: "pf-m-danger",
                onClick: () => confirm_delete(dialogs, path, [item], setSelected)
            },
        );
        if (item.type === "reg") {
            menuItems.push(
                { type: "divider" },
                {
                    id: "download-item",
                    title: _("Download"),
                    onClick: () => downloadFile(path, item)
                }
            );
        } else if (item.type === "dir" && supportsTerminal) {
            menuItems.push(
                { type: "divider" },
                {
                    id: "terminal",
                    title: _("Open in terminal"),
                    onClick: () => cockpit.jump("/system/terminal#/?path=" + encodeURIComponent(path + item.name))
                }
            );
        }
    } else if (selected.length > 1) {
        menuItems.push(
            {
                id: "copy-item",
                title: _("Copy"),
                onClick: () => setClipboard(selected.map(s => path + s.name)),
            },
            {
                id: "delete-item",
                title: _("Delete"),
                className: "pf-m-danger",
                onClick: () => confirm_delete(dialogs, path, selected, setSelected)
            }
        );
    }

    return menuItems;
}

// Get the dirname based on the given path with special logic for "/", so we don't show the root directory as "//"
// As selected.name would already be "/".
function get_base_path(path: string) {
    let base_path = dirname(path);
    if (base_path === "/")
        base_path = "";
    else {
        base_path += "/";
    }

    return base_path;
}
