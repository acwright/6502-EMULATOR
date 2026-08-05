import { createApp } from 'vue'
import { createPinia } from 'pinia'
import EmbedApp from './EmbedApp.vue'
import './style.css'

createApp(EmbedApp).use(createPinia()).mount('#app')
