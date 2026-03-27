import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { SetupGate } from "@/components/setup-gate";
import { PlayerProvider } from "@/lib/player-context";
import { LayoutShell } from "@/components/layout-shell";
import { WaveformPlayer } from "@/components/waveform-player";
import { NuqsAdapter } from "nuqs/adapters/next/app";

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
    icon: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var t=localStorage.getItem('theme');if(t==='light'){document.documentElement.classList.remove('dark')}else{document.documentElement.classList.add('dark')}})();`,
          }}
        />
      </head>
      <body
        className={`${inter.variable} ${geistMono.variable} antialiased h-screen flex flex-row bg-background text-foreground overflow-hidden`}
      >
        <NuqsAdapter>
          <PlayerProvider>
            <Sidebar />
            <LayoutShell>
              <SetupGate>
                {children}
                </SetupGate>
                </LayoutShell>
            <WaveformPlayer />
            <Toaster />
          </PlayerProvider>
        </NuqsAdapter>
      </body>
    </html>
  );
}
