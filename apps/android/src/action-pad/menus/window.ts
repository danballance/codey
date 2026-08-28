import type { ActionMenuDefinition } from "./types";

export const WINDOW_MENU = {
  label: "Window",
  groups: [
    {
      id: "leading",
      buttons: [
        {
          id: "left",
          label: "← Left",
          tap: { type: "input", nvimInput: "<C-w>h", after: "root" },
        },
        {
          id: "down",
          label: "↓ Down",
          tap: { type: "input", nvimInput: "<C-w>j", after: "root" },
        },
        {
          id: "up",
          label: "↑ Up",
          tap: { type: "input", nvimInput: "<C-w>k", after: "root" },
        },
        {
          id: "right",
          label: "→ Right",
          tap: { type: "input", nvimInput: "<C-w>l", after: "root" },
        },
        {
          id: "split",
          label: "Split",
          tap: { type: "input", nvimInput: "<C-w>s", after: "root" },
        },
      ],
    },
    {
      id: "trailing",
      buttons: [
        {
          id: "vertical-split",
          label: "V Split",
          tap: { type: "input", nvimInput: "<C-w>v", after: "root" },
        },
        {
          id: "close",
          label: "Close",
          tap: { type: "input", nvimInput: "<C-w>c", after: "root" },
        },
        {
          id: "only",
          label: "Only",
          tap: { type: "input", nvimInput: "<C-w>o", after: "root" },
        },
        {
          id: "next",
          label: "Next",
          tap: { type: "input", nvimInput: "<C-w>w", after: "root" },
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
