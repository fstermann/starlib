"use client";

import { useEffect } from "react";

import { useCommandPalette } from "./provider";
import type { CommandProvider } from "./types";

/** Register a provider for the component's lifetime. */
export function useRegisterProvider(provider: CommandProvider) {
  const { registerProvider } = useCommandPalette();
  useEffect(() => registerProvider(provider), [provider, registerProvider]);
}
