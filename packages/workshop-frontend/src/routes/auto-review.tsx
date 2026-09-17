import { createFileRoute } from '@tanstack/react-router'
import AutoReviewPage from '../AutoReviewPage'

export const Route = createFileRoute('/auto-review')({ component: AutoReviewPage })
