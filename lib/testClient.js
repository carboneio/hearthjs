const rock = require('rock-req')
const server = require('./server')

class TestClient {
  /**
   * @param {String} email Email used to log in
   * @param {String} password Password used to log in
   * @param {Object} options { followRedirect } — false to stop following 3xx,
   *                 so a test can read the status code and the Location header
   */
  constructor (email, password, options) {
    this.email = email
    this.password = password
    this._cookie = null
    this._authType = 'cookie'
    this._loginRoute = '/login'
    this._logoutRoute = '/logout'
    this._headers = {}
    // Default true, like a browser and like the previous behaviour
    this._followRedirects = !(options && options.followRedirect === false)
  }

  get followRedirect () {
    return this._followRedirects
  }

  set followRedirect (value) {
    this._followRedirects = value !== false
  }

  get cookie () {
    return this._cookie
  }

  set cookie (cookie) {
    this._cookie = cookie
  }

  get authType () {
    return this._authType
  }

  set authType (authType) {
    this._authType = authType
  }

  get loginRoute () {
    return this._loginRoute
  }

  set loginRoute (loginRoute) {
    this._loginRoute = loginRoute
  }

  get logoutRoute () {
    return this._logoutRoute
  }

  set logoutRoute (logoutRoute) {
    this._logoutRoute = logoutRoute
  }

  set headers (headers) {
    this._headers = headers
  }

  /**
   * GET a route
   * @param {String} route Route to call
   * @param {Function} callback
   */
  get (route, callback) {
    rock.get(this._baseOptions(route), (err, response, body) => {
      if (err) {
        return callback(err)
      }

      this._parseBody(response, body, callback)
    })
  }

  /**
   * POST JSON to a route
   * @param {String} route Route to call
   * @param {Object} jsonData Body to send
   * @param {Function} callback
   */
  post (route, jsonData, callback) {
    rock.postJSON(this._baseOptions(route), jsonData, (err, response, body) => {
      if (err) {
        return callback(err)
      }

      return callback(null, response, body)
    })
  }

  /**
   * PUT JSON to a route
   * @param {String} route Route to call
   * @param {Object} jsonData Body to send
   * @param {Function} callback
   */
  put (route, jsonData, callback) {
    rock.putJSON(this._baseOptions(route), jsonData, (err, response, body) => {
      if (err) {
        return callback(err)
      }

      return callback(null, response, body)
    })
  }

  /**
   * DELETE a route
   * @param {String} route Route to call
   * @param {Function} callback
   */
  del (route, callback) {
    rock.delete(this._baseOptions(route), (err, response, body) => {
      if (err) {
        return callback(err)
      }

      this._parseBody(response, body, callback)
    })
  }

  /**
   * Log the user in and keep the cookie or token for the next calls
   * @param {String} route Optional login route
   * @param {Function} callback
   */
  login (route, callback) {
    if (callback === undefined) {
      callback = route
      route = this._loginRoute
    }

    // Check if user is already logged to not call a useless route
    if (this.cookie !== null) {
      return callback(null)
    }

    // Execute login request
    rock.postJSON(this._baseOptions(route), {
      email: this.email,
      password: this.password
    }, (err, response, body) => {
      if (err) {
        return callback(err)
      }

      if (body.data && body.data.token !== undefined) {
        // Check if token is in body
        this.cookie = body.data.token
        this.authType = 'authorization'
        return callback(null, response, body)
      } else if (response.headers['set-cookie'] !== undefined) {
        // Check if cookie exists
        this.cookie = response.headers['set-cookie'][0]
        this.authType = 'cookie'
        return callback(null, response, body)
      }

      return callback(new Error('No token were found'))
    })
  }

  /**
   * Log the user out and forget the credentials
   * @param {String} route Optional logout route
   * @param {Function} callback
   */
  logout (route, callback) {
    if (callback === undefined) {
      callback = route
      route = this._logoutRoute
    }

    // Execute logout request
    rock.get(this._baseOptions(route), (err, response, body) => {
      if (err) {
        return callback(err)
      }

      this.cookie = null
      this._parseBody(response, body, callback)
    })
  }

  /**
   * Parse a JSON body, passing the raw response through when it is not JSON
   * @param {Object} response Response
   * @param {Buffer|String} body Body received
   * @param {Function} callback
   */
  _parseBody (response, body, callback) {
    try {
      body = JSON.parse(body)
    } catch (e) {
      return callback(null, response)
    }

    return callback(null, response, body)
  }

  /**
   * Build the absolute url of a route
   * @param {String} endRoute Route path
   */
  getCompleteUrl (endRoute) {
    return `http://localhost:${server.config.APP_SERVER_PORT}${endRoute}`
  }

  /**
   * The rock-req options shared by every request: the url, the credential
   * carrying headers, and whether 3xx are followed
   * @param {String} route Route path
   * @return {Object}
   */
  _baseOptions (route) {
    return {
      url: this.getCompleteUrl(route),
      headers: this.getHeaders(),
      followRedirects: this._followRedirects
    }
  }

  /**
   * Headers to send, carrying the credentials once logged in
   */
  getHeaders () {
    let toAssign = {}

    if (this._cookie !== null) {
      if (this.authType === 'cookie') {
        toAssign = {
          Cookie: this._cookie
        }
      } else {
        toAssign = {
          Authorization: this._cookie
        }
      }
    }

    return Object.assign(toAssign, this._headers)
  }
}

module.exports = TestClient
