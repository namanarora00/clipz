/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** AI Mode - Which AI backend to use */
  "aiMode": "raycast" | "ollama" | "openai" | "anthropic" | "none",
  /** Ollama URL - URL where Ollama is running (Ollama mode only) */
  "ollamaUrl": string,
  /** Ollama Model - Model for Ollama mode */
  "ollamaModel": string,
  /** Embedding Model - Ollama model used for semantic clipboard search */
  "embeddingModel": string,
  /** API Key - OpenAI or Anthropic API key */
  "apiKey"?: string,
  /** Cloud Model - OpenAI: gpt-4o-mini · Anthropic: claude-haiku-4-5-20251001 */
  "apiModel": string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `search-history` command */
  export type SearchHistory = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `search-history` command */
  export type SearchHistory = {}
}

