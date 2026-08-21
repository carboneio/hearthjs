const crypto = require('crypto')

/**
 * Build a multipart/form-data body: rock-req ships no form-data support, so
 * the tests build the body and send it as a plain buffer.
 */
class MultipartForm {
  constructor () {
    this._boundary = '--------------------------' + crypto.randomBytes(12).toString('hex')
    this._parts = []
  }

  /**
   * Append a field to the form
   * @param {String} name Field name
   * @param {String|Buffer} value Field value
   * @param {Object} options { filename, contentType }
   */
  append (name, value, options = {}) {
    this._parts.push({ name, value, options })
    return this
  }

  getHeaders () {
    return { 'content-type': `multipart/form-data; boundary=${this._boundary}` }
  }

  getBuffer () {
    const chunks = []

    for (let i = 0; i < this._parts.length; i++) {
      const part = this._parts[i]
      let header = `--${this._boundary}\r\nContent-Disposition: form-data; name="${part.name}"`

      if (part.options.filename !== undefined) {
        header += `; filename="${part.options.filename}"`
      }

      header += '\r\n'

      if (part.options.contentType !== undefined) {
        header += `Content-Type: ${part.options.contentType}\r\n`
      }

      header += '\r\n'
      chunks.push(Buffer.from(header))
      chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(String(part.value)))
      chunks.push(Buffer.from('\r\n'))
    }

    chunks.push(Buffer.from(`--${this._boundary}--\r\n`))
    return Buffer.concat(chunks)
  }
}

module.exports = MultipartForm
