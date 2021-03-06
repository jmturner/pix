import 'babel-polyfill'
import bluebird from 'bluebird'
import mongoose from 'mongoose'
import path from 'path'
import express from 'express'
import session from 'express-session'
import bodyParser from 'body-parser'
import http from 'http'
import invariant from 'invariant'
import passport from 'passport'
import graphQLHTTP from 'express-graphql'
import cors from 'cors'
import {getState, writeState} from './state'

bluebird.promisifyAll(require('kue').Job.prototype)

import {User} from '@pix/schema'
import config from './config'
import schema from './graph'

process.on('unhandledRejection', ex => console.error(ex.stack))

const app = express()
const server = http.Server(app)
const io = require('socket.io')(server)
const RedisStore = require('connect-redis')(session)

require('./setup').default()

mongoose.connect(config.mongoUri)

passport.use(User.createStrategy())

passport.serializeUser(User.serializeUser())
passport.deserializeUser(User.deserializeUser())

const sessionMiddleware = session({
  secret: 'changeme',
  cookie: { secure: false, httpOnly: true },
  resave: false,
  saveUninitialized: false,
  store: new RedisStore({ host: config.redisHost, port: config.redisPort }),
})

app.use(bodyParser.json())
app.use(bodyParser.urlencoded())
app.use(sessionMiddleware)
app.use(passport.initialize())
app.use(passport.session())

if (process.env.NODE_ENV !== 'production') {
  console.log('** Enabling cors for development **')
  app.use(cors({ origin: true, credentials: true }))
}

io.use((socket, next) => sessionMiddleware(socket.request, {}, next))

app.post('/api/login', passport.authenticate('local'), (req, res) => {
  res.send({ success: true })
})

app.post('/api/create-admin-account', async (req, res) => {
  const state = await getState()
  invariant(state.firstRun, 'Not first run')

  User.register(new User({ username: req.body.username, role: User.Roles.ADMIN }), req.body.password, async (err, user) => {
    if (err) {
      throw err
    }

    await writeState({ firstRun: false })

    passport.authenticate('local')(req, res, () => {
      res.send({ success: true })
    })
  })
})

app.get('/download', require('./routes/download').default)
app.get('/full-img', require('./routes/full-img').default)

app.use('/graph', graphQLHTTP({
  schema,
  graphiql: true,
  formatError: error => ({
    message: error.message,
    locations: error.locations,
    stack: error.stack,
    errors: error.originalError && error.originalError.errors,
  }),
}))

app.use('/img/thumb', express.static(path.join(config.dataPath, 'thumbnails')))

app.use(express.static(path.join(__dirname, '..', '..', 'pix-web')))
app.all('/*', (req, res) => res.sendFile(path.join(__dirname, '..', '..', 'pix-web', 'index.html')))

server.listen(process.env.PORT || 80, () => {
  console.log(`Listening on port ${server.address().port}`)
})

io.on('connection', socket => {
  require('./socket').default(socket, io)
})
