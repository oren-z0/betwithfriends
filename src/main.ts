import Alpine from 'alpinejs'
import { createApp } from './app'
import './style.css'

declare global {
  interface Window {
    Alpine: typeof Alpine
  }
}

window.Alpine = Alpine
Alpine.data('app', createApp)
Alpine.start()
