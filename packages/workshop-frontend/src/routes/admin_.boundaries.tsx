import { createFileRoute } from '@tanstack/react-router'
import AutoReviewPage from '../AutoReviewPage'

export const Route = createFileRoute('/admin_/boundaries')({ component: () => <AutoReviewPage adminMode /> })
