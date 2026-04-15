// 文件解析：支持 PDF、Word、Excel、PPT、ZIP、音视频、EPUB、纯文本等格式
const { readFileSync, writeFileSync, existsSync, unlinkSync } = require('fs')
const { join, extname } = require('path')
const { execSync } = require('child_process')
const AdmZip = require('adm-zip')
const pdfParse = require('pdf-parse')
const mammoth = require('mammoth')
const XLSX = require('xlsx')
const config = require('./config')

const TEXT_EXTS = /\.(txt|md|json|csv|log|py|js|ts|jsx|tsx|html|css|xml|yaml|yml|ini|cfg|conf|sh|sql|go|rs|c|cpp|h|hpp|java|kt|swift|rb|php|r|m|lua|pl|scala|zig|asm|s|bat|cmd|ps1|psm1|makefile|dockerfile|toml|env|gitignore|editorconfig|prisma|proto|graphql|gql|vue|svelte|astro|hbs|ejs|pug|less|scss|sass|styl|tf|hcl)$/i

async function parseFile(filePath, fileName) {
  const TEMP_DIR = config.getTempDir()
  const ext = extname(fileName || filePath).toLowerCase()

  // PDF
  if (ext === '.pdf') {
    try {
      const buf = readFileSync(filePath)
      const data = await pdfParse(buf)
      const text = data.text?.trim()
      return text ? { name: fileName, content: `[PDF文档, ${data.numpages}页]\n${text.substring(0, 50000)}` } : null
    } catch (e) {
      return { name: fileName, content: `[PDF解析失败: ${e.message}]` }
    }
  }

  // Word (docx)
  if (ext === '.docx') {
    try {
      const result = await mammoth.extractRawText({ path: filePath })
      const text = result.value?.trim()
      return text ? { name: fileName, content: `[Word文档]\n${text.substring(0, 50000)}` } : null
    } catch (e) {
      return { name: fileName, content: `[Word解析失败: ${e.message}]` }
    }
  }

  // Excel (xlsx/xls)
  if (ext === '.xlsx' || ext === '.xls') {
    try {
      const workbook = XLSX.readFile(filePath)
      let output = `[Excel文件, ${workbook.SheetNames.length}个工作表]\n`
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName]
        const csvData = XLSX.utils.sheet_to_csv(sheet)
        output += `\n--- 工作表: ${sheetName} ---\n${csvData.substring(0, 20000)}\n`
      }
      return { name: fileName, content: output.substring(0, 50000) }
    } catch (e) {
      return { name: fileName, content: `[Excel解析失败: ${e.message}]` }
    }
  }

  // PowerPoint (pptx)
  if (ext === '.pptx') {
    try {
      const zip = new AdmZip(filePath)
      const slides = zip.getEntries().filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName)).sort()
      let output = `[PPT文档, ${slides.length}页]\n`
      for (const slide of slides) {
        const xml = slide.getData().toString('utf8')
        const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]).join(' ')
        if (texts) output += `\n--- ${slide.entryName} ---\n${texts}\n`
      }
      return { name: fileName, content: output.substring(0, 50000) }
    } catch (e) {
      return { name: fileName, content: `[PPT解析失败: ${e.message}]` }
    }
  }

  // ZIP
  if (ext === '.zip') {
    try {
      const zip = new AdmZip(filePath)
      const entries = zip.getEntries()
      let output = `[ZIP压缩包, ${entries.length}个文件]\n\n文件列表:\n`
      for (const e of entries) output += `  ${e.entryName} (${e.header.size}B)\n`
      output += '\n'
      for (const entry of entries) {
        if (entry.isDirectory) continue
        const name = entry.entryName
        const entryExt = extname(name).toLowerCase()
        const size = entry.header.size
        if (size > 500000) { output += `--- ${name} --- [文件过大, 跳过]\n\n`; continue }
        if (TEXT_EXTS.test(name) || /\.(txt|md|json|csv|py|js|ts|html|css|xml|yaml|yml)$/i.test(name)) {
          try {
            const content = entry.getData().toString('utf8')
            output += `--- ${name} ---\n${content.substring(0, 10000)}\n\n`
          } catch (_) {}
        } else if (entryExt === '.pdf' || entryExt === '.docx' || entryExt === '.xlsx') {
          const tmpPath = join(TEMP_DIR, `zip-${Date.now()}-${name.replace(/[/\\]/g, '_')}`)
          try {
            writeFileSync(tmpPath, entry.getData())
            const parsed = await parseFile(tmpPath, name)
            if (parsed) output += `--- ${name} ---\n${parsed.content}\n\n`
            try { unlinkSync(tmpPath) } catch (_) {}
          } catch (_) {}
        }
      }
      return { name: fileName, content: output.substring(0, 80000) }
    } catch (e) {
      return { name: fileName, content: `[ZIP解析失败: ${e.message}]` }
    }
  }

  // 音频
  if (/\.(mp3|wav|m4a|ogg|flac|aac|wma)$/i.test(ext)) {
    try {
      const probe = execSync(`ffprobe -v quiet -print_format json -show_format "${filePath}"`, { timeout: 10000 }).toString()
      const info = JSON.parse(probe)
      const duration = parseFloat(info.format?.duration || 0)
      let output = `[音频文件: ${fileName}, 时长: ${Math.round(duration)}秒, 格式: ${info.format?.format_long_name || ext}]`
      try {
        execSync(`whisper "${filePath}" --model tiny --language zh --output_format txt --output_dir "${TEMP_DIR}" 2>/dev/null`, { timeout: 120000 })
        const txtPath = join(TEMP_DIR, fileName.replace(extname(fileName), '.txt'))
        if (existsSync(txtPath)) {
          const transcript = readFileSync(txtPath, 'utf-8').trim()
          if (transcript) output += `\n语音转文字:\n${transcript}`
          try { unlinkSync(txtPath) } catch (_) {}
        }
      } catch (_) {
        output += '\n(未安装 whisper，无法转文字。可用 pip install openai-whisper 安装)'
      }
      return { name: fileName, content: output }
    } catch (e) {
      return { name: fileName, content: `[音频文件: ${fileName}, 无法解析元信息]` }
    }
  }

  // 视频
  if (/\.(mp4|mov|avi|mkv|webm|flv|wmv|m4v)$/i.test(ext)) {
    try {
      const probe = execSync(`ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`, { timeout: 10000 }).toString()
      const info = JSON.parse(probe)
      const duration = parseFloat(info.format?.duration || 0)
      const videoStream = info.streams?.find(s => s.codec_type === 'video')
      let output = `[视频文件: ${fileName}, 时长: ${Math.round(duration)}秒, 分辨率: ${videoStream?.width || '?'}x${videoStream?.height || '?'}, 格式: ${info.format?.format_long_name || ext}]`
      const framePaths = []
      const frameCount = Math.min(4, Math.max(1, Math.floor(duration / 30)))
      for (let i = 0; i < frameCount; i++) {
        const ts = Math.floor((duration / (frameCount + 1)) * (i + 1))
        const framePath = join(TEMP_DIR, `frame-${Date.now()}-${i}.jpg`)
        try {
          execSync(`ffmpeg -y -ss ${ts} -i "${filePath}" -vframes 1 -q:v 3 "${framePath}" 2>/dev/null`, { timeout: 15000 })
          if (existsSync(framePath)) framePaths.push(framePath)
        } catch (_) {}
      }
      return { name: fileName, content: output, framePaths }
    } catch (e) {
      return { name: fileName, content: `[视频文件: ${fileName}, 无法解析]` }
    }
  }

  // EPUB
  if (ext === '.epub') {
    try {
      const zip = new AdmZip(filePath)
      const entries = zip.getEntries().filter(e => /\.(html|xhtml|htm)$/i.test(e.entryName))
      let output = `[EPUB电子书, ${entries.length}个章节]\n`
      for (const entry of entries) {
        const html = entry.getData().toString('utf8')
        const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        if (text.length > 10) output += `\n${text.substring(0, 5000)}\n`
      }
      return { name: fileName, content: output.substring(0, 50000) }
    } catch (e) {
      return { name: fileName, content: `[EPUB解析失败: ${e.message}]` }
    }
  }

  // 纯文本（兜底）
  if (TEXT_EXTS.test(fileName || '')) {
    try {
      const content = readFileSync(filePath, 'utf-8')
      return { name: fileName, content }
    } catch (_) {}
  }

  // 其他未知格式 - 尝试当文本读
  try {
    const buf = readFileSync(filePath)
    const sample = buf.slice(0, 1000)
    let nonText = 0
    for (const b of sample) if (b === 0 || (b < 7 && b > 0)) nonText++
    if (nonText < sample.length * 0.1) {
      const content = buf.toString('utf-8')
      return { name: fileName, content: content.substring(0, 50000) }
    }
  } catch (_) {}

  return { name: fileName, content: `[不支持的文件格式: ${ext}, 文件名: ${fileName}]` }
}

module.exports = { TEXT_EXTS, parseFile }
