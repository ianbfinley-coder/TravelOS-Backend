#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

console.log('🚀 TravelOS Phase B - Documentation Bundle Creator');
console.log('');

const claudeDir = path.join(process.cwd(), 'claude');
const docsDir = path.join(process.cwd(), 'docs');
const bundleDir = path.join(process.cwd(), 'bundle-temp');
const bundleMetaDir = path.join(bundleDir, 'META');
const bundleFeaturesDir = path.join(bundleDir, 'FEATURES');
const bundleInfraDir = path.join(bundleDir, 'INFRASTRUCTURE');
const bundleArchDir = path.join(bundleDir, 'ARCHITECTURE');

if (!fs.existsSync(claudeDir)) {
    console.error('❌ Error: claude/ directory not found');
    process.exit(1);
}

console.log('📁 Creating bundle directory structure...');
[bundleDir, bundleMetaDir, bundleFeaturesDir, bundleInfraDir, bundleArchDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

console.log('✅ Bundle directories created');
console.log('📋 Copying documentation files...');
const claudeFiles = fs.readdirSync(claudeDir).filter(f => f.endsWith('.md'));
claudeFiles.forEach(file => {
    const src = path.join(claudeDir, file);
    const dest = path.join(bundleFeaturesDir, file);
    fs.copyFileSync(src, dest);
});
console.log(`✅ Copied ${claudeFiles.length} documentation files`);

if (fs.existsSync(docsDir)) {
    console.log('📋 Copying docs directory...');
    copyDirRecursive(docsDir, path.join(bundleDir, 'docs'));
    console.log('✅ Docs directory copied');
}

console.log('📝 Creating manifest file...');
const manifest = {
    version: '1.0.0',
    created: new Date().toISOString(),
    name: 'TravelOS Documentation Bundle',
    description: 'Complete TravelOS documentation, feature specifications, and infrastructure guides',
    files: claudeFiles,
    totalFiles: claudeFiles.length,
    timestamp: Date.now()
};

fs.writeFileSync(path.join(bundleMetaDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
console.log('✅ Manifest created');

const readmeContent = `# TravelOS Documentation Bundle v1.0.0\n\nGenerated: ${new Date().toISOString()}\n\n## Contents\n\n- **FEATURES**: All feature specifications and documentation\n- **docs**: Additional documentation and guides\n\n## How to Use\n\n1. Extract this ZIP file\n2. Review the documentation\n3. Use the feature prompts to guide development\n`;

fs.writeFileSync(path.join(bundleMetaDir, 'README.md'), readmeContent);
console.log('✅ README created');

fs.writeFileSync(path.join(bundleMetaDir, 'VERSION.txt'), '1.0.0\n');

const changelogContent = `# Changelog\n\n## v1.0.0 - Initial Release\n\n### Added\n- Complete Phase 5 feature specifications\n- Complete Phase 4 feature specifications\n- Infrastructure guides\n- Architecture reference documents\n`;

fs.writeFileSync(path.join(bundleMetaDir, 'CHANGELOG.md'), changelogContent);
console.log('✅ Changelog created');

console.log('🔐 Calculating checksums...');
const checksums = {};
claudeFiles.forEach(file => {
    const filePath = path.join(bundleFeaturesDir, file);
    const content = fs.readFileSync(filePath);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    checksums[file] = hash;
});

fs.writeFileSync(
    path.join(bundleMetaDir, 'CHECKSUMS.sha256'),
    Object.entries(checksums).map(([file, hash]) => `${hash}  ${file}`).join('\n')
);
console.log(`✅ Checksums calculated for ${claudeFiles.length} files`);

console.log('📦 Creating ZIP archive...');
const zipPath = path.join(process.cwd(), 'TravelOS-Documentation-Bundle-v1.0.0.zip');
const bundlePath = path.resolve(bundleDir);
const zipAbsPath = path.resolve(zipPath);

try {
    const isWindows = process.platform === 'win32';
    if (isWindows) {
        const psCommand = `Compress-Archive -Path "${bundlePath}" -DestinationPath "${zipAbsPath}" -Force`;
        execSync(`powershell -Command "${psCommand}"`, { stdio: 'inherit' });
    } else {
        execSync(`cd "${path.dirname(bundlePath)}" && zip -r "${zipAbsPath}" "${path.basename(bundlePath)}"`, { stdio: 'inherit' });
    }
    console.log(`✅ ZIP archive created: ${zipPath}`);
} catch (error) {
    console.error('❌ Error creating ZIP archive:', error.message);
    process.exit(1);
}

console.log('🔐 Calculating ZIP checksum...');
const zipContent = fs.readFileSync(zipPath);
const zipHash = crypto.createHash('sha256').update(zipContent).digest('hex');

fs.writeFileSync(
    path.join(process.cwd(), 'TravelOS-Documentation-Bundle-v1.0.0.zip.sha256'),
    `${zipHash}  TravelOS-Documentation-Bundle-v1.0.0.zip\n`
);
console.log(`✅ ZIP checksum: ${zipHash}`);

console.log('🧹 Cleaning up temporary files...');
try {
    fs.rmSync(bundleDir, { recursive: true, force: true });
    console.log('✅ Temporary directory removed');
} catch (error) {
    console.warn('⚠️ Could not remove temporary directory (non-blocking)');
}

console.log('');
console.log('✅ Phase B Complete!');
console.log('');
console.log('📊 Bundle Summary:');
console.log(`  - Name: TravelOS-Documentation-Bundle-v1.0.0.zip`);
console.log(`  - Files: ${claudeFiles.length} documentation files`);
console.log(`  - Size: ${(zipContent.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`  - Checksum: ${zipHash}`);
console.log('');
console.log('🎯 Next Steps:');
console.log('1. git add TravelOS-Documentation-Bundle-v1.0.0.zip');
console.log('2. git add TravelOS-Documentation-Bundle-v1.0.0.zip.sha256');
console.log('3. git commit -m "feat: add Phase B documentation bundle"');
console.log('4. git push origin main');

function copyDirRecursive(src, dest) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    const files = fs.readdirSync(src);
    files.forEach(file => {
        const srcPath = path.join(src, file);
        const destPath = path.join(dest, file);
        if (fs.statSync(srcPath).isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    });
}
