"use client";

import { createContext, useContext } from "react";

export type LoaderPhase = "travel" | "exit" | "done";

const LoaderPhaseContext = createContext<LoaderPhase>("done");

export const LoaderPhaseProvider = LoaderPhaseContext.Provider;

export function useLoaderPhase(): LoaderPhase {
  return useContext(LoaderPhaseContext);
}
