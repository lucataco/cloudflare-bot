import { createFileRoute } from '@tanstack/react-router'
import AttentionPage from '../AttentionPage'

export const Route = createFileRoute('/attention')({ component: AttentionPage })
