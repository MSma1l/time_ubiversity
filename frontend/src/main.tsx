import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import './utm.css'
import './icons.css'
import './calendar.css'
import './settings.css'
import './editor-position.css'
import './catalog.css'
import './catalog-refined.css'
import './scrollbars.css'
import { App } from './App'
import { initializeTelegram } from './telegram'

initializeTelegram()

const root = document.getElementById('root')
if (!root) throw new Error('Root element #root is missing')
createRoot(root).render(<StrictMode><App /></StrictMode>)
