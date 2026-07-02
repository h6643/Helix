import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ErrorBoundary } from "@/components/Helix/error-boundary";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Helix",
  description: "AI coding assistant",
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' fill='%23111'/><rect x='8' y='0' width='3' height='6' fill='%23ff4757'/><rect x='21' y='0' width='3' height='6' fill='%23ff4757'/><rect x='5' y='2' width='3' height='4' fill='%23ff4757'/><rect x='24' y='2' width='3' height='4' fill='%23ff4757'/><rect x='4' y='6' width='24' height='16' fill='%23ffd93d'/><rect x='6' y='6' width='8' height='8' fill='%23fff'/><rect x='18' y='6' width='8' height='8' fill='%23fff'/><rect x='8' y='7' width='6' height='7' fill='%23222'/><rect x='18' y='7' width='6' height='7' fill='%23222'/><rect x='13' y='14' width='6' height='4' fill='%23ff4757'/><rect x='6' y='20' width='20' height='3' fill='%23ffc107'/></svg>",
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
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground overflow-hidden`}
      >
        <ErrorBoundary>
          {children}
        </ErrorBoundary>
        <Toaster />
      </body>
    </html>
  );
}
