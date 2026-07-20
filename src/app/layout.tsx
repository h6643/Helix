import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
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
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' fill='%233a3a3a'/><rect x='10' y='0' width='2' height='3' fill='%2338bdf8'/><rect x='20' y='0' width='2' height='3' fill='%2338bdf8'/><rect x='8' y='3' width='3' height='2' fill='%2338bdf8'/><rect x='21' y='3' width='3' height='2' fill='%2338bdf8'/><rect x='13' y='1' width='6' height='3' fill='%2322c55e'/><rect x='12' y='3' width='2' height='2' fill='%2322c55e'/><rect x='18' y='3' width='2' height='2' fill='%2322c55e'/><rect x='5' y='5' width='22' height='13' rx='2' fill='%23fbbf24'/><rect x='7' y='5' width='3' height='3' fill='%23f59e0b'/><rect x='22' y='5' width='3' height='3' fill='%23f59e0b'/><rect x='7' y='8' width='6' height='5' fill='%23fff'/><rect x='19' y='8' width='6' height='5' fill='%23fff'/><rect x='8' y='9' width='4' height='3' fill='%23222'/><rect x='20' y='9' width='4' height='3' fill='%23222'/><rect x='9' y='9' width='1' height='1' fill='%23fff'/><rect x='21' y='9' width='1' height='1' fill='%23fff'/><rect x='6' y='14' width='4' height='2' fill='%23f87171' opacity='0.8'/><rect x='22' y='14' width='4' height='2' fill='%23f87171' opacity='0.8'/><rect x='13' y='14' width='6' height='2' fill='%23222'/><rect x='14' y='16' width='4' height='1' fill='%23e11d48'/><rect x='12' y='18' width='8' height='1' fill='%23222'/><rect x='14' y='19' width='2' height='1' fill='%23222'/><rect x='16' y='19' width='2' height='1' fill='%23222'/><rect x='5' y='18' width='4' height='3' fill='%23fbbf24'/><rect x='23' y='18' width='4' height='3' fill='%23fbbf24'/><rect x='25' y='16' width='3' height='3' fill='%23fbbf24'/><rect x='26' y='15' width='2' height='2' fill='%23fbbf24'/><rect x='8' y='19' width='16' height='3' fill='%23fbbf24'/><rect x='10' y='22' width='12' height='2' fill='%23fde68a'/><rect x='12' y='24' width='8' height='1' fill='%23fde68a'/><rect x='7' y='22' width='4' height='2' fill='%2322c55e'/><rect x='21' y='22' width='4' height='2' fill='%2322c55e'/><rect x='3' y='19' width='3' height='4' fill='%2322c55e'/><rect x='26' y='19' width='3' height='4' fill='%2322c55e'/><rect x='8' y='25' width='4' height='3' fill='%23fbbf24'/><rect x='14' y='25' width='4' height='3' fill='%23fbbf24'/><rect x='20' y='25' width='4' height='3' fill='%23fbbf24'/><rect x='9' y='28' width='3' height='3' fill='%2322c55e'/><rect x='15' y='28' width='3' height='3' fill='%2322c55e'/><rect x='21' y='28' width='3' height='3' fill='%2322c55e'/></svg>",
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
            __html: `(function(){try{var t=localStorage.getItem('helix-theme')||'dark';document.documentElement.classList.toggle('dark',t==='dark')}catch(e){}})()`,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground overflow-hidden`}
      >
        <ErrorBoundary>
          {children}
        </ErrorBoundary>
      </body>
    </html>
  );
}
