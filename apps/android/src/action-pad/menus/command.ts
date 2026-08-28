import type { ActionMenuDefinition } from "./types";

export const COMMAND_MENU = {
  label: "Cmd",
  groups: [
    {
      id: "leading",
      buttons: [
        {
          id: "save",
          label: "Save",
          tap: { type: "input", nvimInput: ":w<CR>", after: "root" },
        },
        {
          id: "save-all",
          label: "Save All",
          tap: { type: "input", nvimInput: ":wa<CR>", after: "root" },
        },
        {
          id: "quit",
          label: "Quit",
          tap: { type: "input", nvimInput: ":q<CR>", after: "root" },
        },
        {
          id: "force-quit",
          label: "Force Quit",
          tap: { type: "input", nvimInput: ":q!<CR>", after: "root" },
        },
      ],
    },
    {
      id: "trailing",
      buttons: [
        {
          id: "write-quit",
          label: "Write and Quit",
          tap: { type: "input", nvimInput: ":wq<CR>", after: "root" },
        },
        {
          id: "undo",
          label: "Undo",
          tap: { type: "input", nvimInput: "u", after: "root" },
        },
        {
          id: "redo",
          label: "Redo",
          tap: { type: "input", nvimInput: "<C-r>", after: "root" },
        },
        {
          id: "back",
          label: "Back",
          tap: { type: "back", after: "stay" },
        },
      ],
    },
  ],
} as const satisfies ActionMenuDefinition;
