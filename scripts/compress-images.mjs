import sharp from 'sharp'
import { readdirSync, statSync } from 'fs'
import { join, extname } from 'path'

const PUBLIC = new URL('../public', import.meta.url).pathname
const MAX_BYTES = 500 * 1024 // 500KB

const images = readdirSync(PUBLIC).filter((f) =>
  ['.png', '.jpg', '.jpeg'].includes(extname(f).toLowerCase())
)

for (const file of images) {
  const filePath = join(PUBLIC, file)
  const sizeBefore = statSync(filePath).size

  if (sizeBefore <= MAX_BYTES) {
    console.log(`${file}: ${(sizeBefore / 1024).toFixed(0)}KB — already under 500KB, optimizing anyway`)
  } else {
    console.log(`${file}: ${(sizeBefore / 1024).toFixed(0)}KB — compressing...`)
  }

  const image = sharp(filePath)
  const meta = await image.metadata()

  let pipeline = image

  // Resize if very large (max 2000px wide)
  if (meta.width && meta.width > 2000) {
    pipeline = pipeline.resize(2000, undefined, { withoutEnlargement: true })
  }

  const buffer = await pipeline.png({ quality: 85, compressionLevel: 9 }).toBuffer()
  const sizeAfter = buffer.length

  // If PNG is still too large, try webp-quality PNG or just keep it
  await sharp(buffer).toFile(filePath)
  console.log(`  → ${(sizeAfter / 1024).toFixed(0)}KB (saved ${((1 - sizeAfter / sizeBefore) * 100).toFixed(0)}%)`)

  // Generate favicon from icon.png / Icon.PNG
  if (file.toLowerCase() === 'icon.png') {
    const faviconPath = join(PUBLIC, 'favicon.png')
    await sharp(filePath)
      .resize(64, 64, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(faviconPath)
    console.log(`  → Generated favicon.png (64x64)`)

    const favicon32Path = join(PUBLIC, 'favicon-32.png')
    await sharp(filePath)
      .resize(32, 32, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(favicon32Path)
    console.log(`  → Generated favicon-32.png (32x32)`)
  }
}

console.log('\nDone!')
