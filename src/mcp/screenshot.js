/**
 * Headless cross-platform screenshot capture.
 *
 * Replaces the Electron desktopCapturer path of askService with OS-native
 * capture commands, then downsizes with sharp (if available) exactly like the
 * Electron app does (height 384, JPEG q80 by default) to keep the image
 * token-cheap for the client LLM.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const execFile = util.promisify(require('child_process').execFile);

let sharp = null;
try {
    sharp = require('sharp');
} catch {
    // Optional — screenshots are returned unresized without it.
}

async function captureRaw(tempPath) {
    if (process.platform === 'darwin') {
        await execFile('screencapture', ['-x', '-t', 'jpg', tempPath]);
        return;
    }

    if (process.platform === 'win32') {
        const ps = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save('${tempPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$g.Dispose(); $bmp.Dispose()`;
        await execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
        return;
    }

    // Linux: try common tools (X11 and Wayland) in order.
    const candidates = [
        ['gnome-screenshot', ['-f', tempPath]],
        ['spectacle', ['-b', '-n', '-o', tempPath]],
        ['scrot', ['-o', tempPath]],
        ['import', ['-window', 'root', tempPath]], // ImageMagick
        ['grim', [tempPath]],                      // Wayland
    ];
    const errors = [];
    for (const [cmd, args] of candidates) {
        try {
            await execFile(cmd, args);
            return;
        } catch (err) {
            errors.push(`${cmd}: ${err.code === 'ENOENT' ? 'not installed' : err.message}`);
        }
    }
    throw new Error(`No screenshot tool available. Tried: ${errors.join('; ')}`);
}

/**
 * @returns {Promise<{base64: string, width: number|null, height: number|null}>}
 */
async function captureScreenshot({ height = 384, quality = 80 } = {}) {
    const tempPath = path.join(os.tmpdir(), `glass-mcp-shot-${Date.now()}.jpg`);
    try {
        await captureRaw(tempPath);
        const imageBuffer = await fs.promises.readFile(tempPath);

        if (sharp) {
            const resized = await sharp(imageBuffer)
                .resize({ height })
                .jpeg({ quality })
                .toBuffer();
            const metadata = await sharp(resized).metadata();
            return { base64: resized.toString('base64'), mimeType: 'image/jpeg', width: metadata.width, height: metadata.height };
        }
        // Some Linux tools write PNG regardless of the requested extension.
        const isPng = imageBuffer.length > 8 && imageBuffer.readUInt32BE(0) === 0x89504e47;
        return {
            base64: imageBuffer.toString('base64'),
            mimeType: isPng ? 'image/png' : 'image/jpeg',
            width: null,
            height: null,
        };
    } finally {
        fs.promises.unlink(tempPath).catch(() => {});
    }
}

module.exports = { captureScreenshot };
