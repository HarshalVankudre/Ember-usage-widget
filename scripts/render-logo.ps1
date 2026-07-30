# Crops the Ember badge from the supplied master artwork and renders the
# in-app mark, Windows icon, and tray icon. Pure GDI+ — no npm dependencies.
# Master art: src/assets/logo.png.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$iconsDir = Join-Path $root 'src-tauri\icons'
$rendererAssetsDir = Join-Path $root 'src\renderer\assets'
$sourcePath = Join-Path $root 'src\assets\logo.png'
New-Item -ItemType Directory -Force $iconsDir | Out-Null
New-Item -ItemType Directory -Force $rendererAssetsDir | Out-Null

if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw "Missing master artwork: $sourcePath"
}

$sourceImage = [System.Drawing.Image]::FromFile($sourcePath)

# The master is 1254px square. This crop isolates the upper badge while the
# rounded clip removes its surrounding glow and excludes the wordmark.
$sourceCrop = New-Object System.Drawing.Rectangle(307, 86, 640, 640)

function New-RoundedRect(
  [float]$x,
  [float]$y,
  [float]$width,
  [float]$height,
  [float]$radius
) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = 2 * $radius
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc(
    $x + $width - $diameter,
    $y + $height - $diameter,
    $diameter,
    $diameter,
    0,
    90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Render-Badge([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap(
    $size,
    $size,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $scale = $size / 640.0
  $badgeClip = New-RoundedRect (
    33 * $scale) (
    38 * $scale) (
    574 * $scale) (
    562 * $scale) (
    129 * $scale)
  $g.SetClip($badgeClip)
  $destination = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $g.DrawImage(
    $sourceImage,
    $destination,
    $sourceCrop.X,
    $sourceCrop.Y,
    $sourceCrop.Width,
    $sourceCrop.Height,
    [System.Drawing.GraphicsUnit]::Pixel)
  $badgeClip.Dispose()
  $g.Dispose()
  return $bmp
}

function Get-PngBytes([System.Drawing.Bitmap]$bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose()
  return $bytes
}

function Get-DibBytes([System.Drawing.Bitmap]$bmp) {
  # Classic ICO payload: BITMAPINFOHEADER + bottom-up BGRA pixels + AND mask.
  # Explorer and .NET both accept PNG only for the 256px slot.
  $size = $bmp.Width
  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $data = $bmp.LockBits($rect, 'ReadOnly', [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride
  $pixels = New-Object byte[] ($stride * $size)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pixels, 0, $pixels.Length)
  $bmp.UnlockBits($data)

  $maskRow = [int](([math]::Ceiling($size / 32.0)) * 4)
  $ms = New-Object System.IO.MemoryStream
  $w = New-Object System.IO.BinaryWriter($ms)
  $w.Write([uint32]40)                    # BITMAPINFOHEADER
  $w.Write([int32]$size)
  $w.Write([int32]($size * 2))            # XOR + AND heights
  $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]0)                     # BI_RGB
  $w.Write([uint32]($size * $size * 4 + $maskRow * $size))
  $w.Write([int32]0); $w.Write([int32]0); $w.Write([uint32]0); $w.Write([uint32]0)
  for ($y = $size - 1; $y -ge 0; $y--) {  # bottom-up rows
    $w.Write($pixels, $y * $stride, $size * 4)
  }
  $w.Write((New-Object byte[] ($maskRow * $size)))  # empty AND mask (alpha rules)
  $bytes = $ms.ToArray()
  $w.Dispose(); $ms.Dispose()
  return $bytes
}

# --- icon.ico: DIB entries, PNG for the 256px slot, largest first ---
$sizes = 256, 128, 64, 48, 32, 24, 16
$images = @()
foreach ($size in $sizes) {
  $bmp = Render-Badge $size
  $bytes = if ($size -ge 256) { Get-PngBytes $bmp } else { Get-DibBytes $bmp }
  $images += , @($size, $bytes)
  $bmp.Dispose()
}

$icoPath = Join-Path $iconsDir 'icon.ico'
$fs = [System.IO.File]::Create($icoPath)
$w = New-Object System.IO.BinaryWriter($fs)
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($img in $images) {
  $size = $img[0]; $bytes = $img[1]
  $w.Write([byte]($(if ($size -ge 256) { 0 } else { $size })))
  $w.Write([byte]($(if ($size -ge 256) { 0 } else { $size })))
  $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$bytes.Length); $w.Write([uint32]$offset)
  $offset += $bytes.Length
}
foreach ($img in $images) {
  $blob = [byte[]]$img[1]
  $w.Write($blob, 0, $blob.Length)
}
$w.Dispose(); $fs.Dispose()

# sanity: every declared size must load back as an icon
foreach ($size in $sizes) {
  $probe = New-Object System.Drawing.Icon($icoPath, $size, $size)
  $probe.Dispose()
}

# --- renderer asset: high-resolution mark for every in-app placement ---
$rendererMark = Render-Badge 512
$rendererMark.Save(
  (Join-Path $rendererAssetsDir 'logo-mark.png'),
  [System.Drawing.Imaging.ImageFormat]::Png)
$rendererMark.Dispose()

# --- tray.png ---
$tray = Render-Badge 32
$tray.Save((Join-Path $iconsDir 'tray.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$tray.Dispose()
$sourceImage.Dispose()

Write-Output "wrote logo-mark.png, $icoPath ($($images.Count) sizes), and tray.png"
