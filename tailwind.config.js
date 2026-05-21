/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  safelist: [
    'absolute',
    'fixed',
    'relative',
    'inset-0',
    'flex',
    'grid',
    'min-h-screen',
    'w-full',
    'h-full',
    'overflow-hidden',
    'items-center',
    'justify-center',
    'text-white',
    'bg-black',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
