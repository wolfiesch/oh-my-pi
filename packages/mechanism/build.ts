import * as fs from "node:fs/promises";

// Clean dist
await fs.rm("./dist/client", { recursive: true, force: true });
await fs.mkdir("./dist/client", { recursive: true });

// Copy styles.css if exists, or write a default one
let sourceCss = "";
try {
	sourceCss = await Bun.file("./src/client/styles.css").text();
} catch {
	sourceCss = `
body {
	margin: 0;
	padding: 0;
	background-color: #050505;
	color: #e5c158;
	font-family: monospace;
	overflow: hidden;
}
	`;
}
await Bun.write("./dist/client/styles.css", sourceCss);

// Build client JS
console.log("Building client JS...");
const result = await Bun.build({
	entrypoints: ["./src/client/main.ts"],
	outdir: "./dist/client",
	minify: true,
	naming: "[dir]/[name].[ext]",
});

if (!result.success) {
	console.error("Build failed");
	for (const message of result.logs) {
		console.error(message);
	}
	process.exit(1);
}

// Create index.html
const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>The Mechanism - Live OMP Orrery</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div id="root"></div>
    <script src="main.js" type="module"></script>
</body>
</html>`;

await Bun.write("./dist/client/index.html", indexHtml);

console.log("Build complete");
