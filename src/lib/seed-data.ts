import type { FileNode } from '@/stores/helix-store'

export const defaultFiles: FileNode[] = [
  {
    id: 'root-src',
    name: 'src',
    type: 'folder',
    children: [
      {
        id: 'file-app',
        name: 'App.tsx',
        type: 'file',
        language: 'typescript',
        content: `import React from 'react';\nimport { Counter } from './components/Counter';\n\nexport default function App() {\n  return (\n    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">\n      <header className="bg-white dark:bg-gray-800 shadow-sm">\n        <div className="max-w-7xl mx-auto px-4 py-4">\n          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">\n            My App\n          </h1>\n        </div>\n      </header>\n      <main className="max-w-7xl mx-auto px-4 py-8">\n        <Counter />\n      </main>\n    </div>\n  );\n}`,
      },
      {
        id: 'folder-components',
        name: 'components',
        type: 'folder',
        children: [
          {
            id: 'file-counter',
            name: 'Counter.tsx',
            type: 'file',
            language: 'typescript',
            content: `import React, { useState } from 'react';\n\ninterface CounterProps {\n  initialValue?: number;\n}\n\nexport function Counter({ initialValue = 0 }: CounterProps) {\n  const [count, setCount] = useState(initialValue);\n\n  return (\n    <div className="flex flex-col items-center gap-4">\n      <span className="text-5xl font-bold text-gray-800 dark:text-gray-200">\n        {count}\n      </span>\n      <div className="flex gap-3">\n        <button\n          onClick={() => setCount(c => c - 1)}\n          className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition"\n        >\n          -1\n        </button>\n        <button\n          onClick={() => setCount(0)}\n          className="px-4 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600 transition"\n        >\n          Reset\n        </button>\n        <button\n          onClick={() => setCount(c => c + 1)}\n          className="px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 transition"\n        >\n          +1\n        </button>\n      </div>\n    </div>\n  );\n}`,
          },
        ],
      },
      {
        id: 'file-styles',
        name: 'index.css',
        type: 'file',
        language: 'css',
        content: `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n:root {\n  --primary: #3b82f6;\n  --primary-dark: #2563eb;\n}\n\nbody {\n  font-family: 'Inter', sans-serif;\n}`,
      },
    ],
  },
  {
    id: 'file-package',
    name: 'package.json',
    type: 'file',
    language: 'json',
    content: `{\n  "name": "my-project",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": {\n    "dev": "next dev",\n    "build": "next build",\n    "start": "next start"\n  },\n  "dependencies": {\n    "react": "^19.0.0",\n    "react-dom": "^19.0.0",\n    "next": "^16.0.0"\n  }\n}`,
  },
  {
    id: 'file-readme',
    name: 'README.md',
    type: 'file',
    language: 'markdown',
    content: `# My Project\n\nA modern web application built with React and Next.js.\n\n## Getting Started\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n\nOpen [http://localhost:3000](http://localhost:3000) to view it in the browser.`,
  },
  {
    id: 'file-gitignore',
    name: '.gitignore',
    type: 'file',
    language: 'plaintext',
    content: `node_modules\n.next\n.env.local\n*.log`,
  },
]
