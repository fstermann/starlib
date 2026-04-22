import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";

import "./globals.css";

import { ThemeProvider } from "next-themes";
import { NuqsAdapter } from "nuqs/adapters/next/app";

import { BackendGate } from "@/components/backend-gate";
import {
  CommandPalette,
  CommandPaletteProvider,
} from "@/components/command-palette";
import { DeepLinkListener } from "@/components/deep-link-listener";
import { LayoutShell } from "@/components/layout-shell";
import { TopBar } from "@/components/layout/top-bar";
import { TopBarProvider } from "@/components/layout/top-bar-context";
import { LogInit } from "@/components/log-init";
import { SetupGate } from "@/components/setup-gate";
import { Sidebar } from "@/components/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UpdateBanner } from "@/components/update-banner";
import { WaveformPlayer } from "@/components/waveform-player";
import { PlayerProvider } from "@/lib/player-context";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Starlib",
  description: "Music management tools for DJs and producers",
  icons: {
    icon: "/favicon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${geistMono.variable} bg-background text-foreground flex h-screen flex-row overflow-hidden antialiased`}
      >
        <LogInit />
        <DeepLinkListener />
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
          <TooltipProvider>
            <BackendGate>
              <NuqsAdapter>
                <PlayerProvider>
                  <TopBarProvider>
                    <CommandPaletteProvider>
                      <Sidebar />
                      <TopBar />
                      <LayoutShell>
                        <UpdateBanner />
                        <SetupGate>{children}</SetupGate>
                      </LayoutShell>
                      <WaveformPlayer />
                      <Toaster />
                      <CommandPalette />
                    </CommandPaletteProvider>
                  </TopBarProvider>
                </PlayerProvider>
              </NuqsAdapter>
            </BackendGate>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
