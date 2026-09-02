import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/agent/$id/skills')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/agents/$id',
      params: { id: params.id },
      search: { pane: 'skills' },
      replace: true,
    })
  },
  component: () => null,
})
