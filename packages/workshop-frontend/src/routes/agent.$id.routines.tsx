import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/agent/$id/routines')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/agents/$id',
      params: { id: params.id },
      search: { pane: 'routines' },
      replace: true,
    })
  },
  component: () => null,
})
