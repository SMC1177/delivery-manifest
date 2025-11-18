/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html", // Looks for classes in your main HTML file
    "./main.js",    // Looks for dynamically created classes in your main JS file
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}