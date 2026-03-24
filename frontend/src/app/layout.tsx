import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { PlayerProvider } from "@/lib/player-context";
import { LayoutShell } from "@/components/layout-shell";
import { WaveformPlayer } from "@/components/waveform-player";

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
    icon: "/favicon.svg",
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
        <PlayerProvider>
          <Sidebar />
          <LayoutShell>{children}</LayoutShell>
          <WaveformPlayer />
          <Toaster />
        </PlayerProvider>
      </body>
    </html>
  );
}
