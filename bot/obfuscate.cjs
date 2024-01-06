const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const inputFilePath = path.join(__dirname, "dist", "consumer.js");
const outputFilePath = path.join(__dirname, "dist", "consumer-obfuscated.js");

const inputCode = fs.readFileSync(inputFilePath, "utf-8");

const obfuscationResult = JavaScriptObfuscator.obfuscate(inputCode, {
  // You can specify the obfuscation options here, for example:
  compact: true,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  controlFlowFlattening: true,
  stringArrayThreshold: 0.9,
  disableConsoleOutput: true,
});

const obfuscatedCode = obfuscationResult.getObfuscatedCode();
fs.writeFileSync(outputFilePath, obfuscatedCode, "utf-8");

// rename consumer-obfuscated.js to consumer.js
fs.renameSync(outputFilePath, inputFilePath);
