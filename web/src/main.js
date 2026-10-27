import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import './theme-cyberpunk.css'
import '@xterm/xterm/css/xterm.css'
import { bootstrapToken } from './api.js'

await bootstrapToken()

createApp(App).mount('#app')
