import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SoundCloud Tools",
  description: "Music management tools for DJs and producers",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased h-screen flex flex-row bg-background text-foreground overflow-hidden`}
      >
        <Sidebar />
        <main className="flex-1 min-w-0 ml-14 flex flex-col overflow-hidden">
          {children}
        </main>
        <Toaster />
      </body>
    </html>
  );
}
