import type {
  ActivityEvent,
  CanvasData,
  Dashboard,
  ItemDetail,
  ItemListPage,
  Me,
  NotificationItem,
  Page,
  PersonProfile,
  ProjectDetail,
  ProjectSummary,
  RoleHistoryRow,
  WorkerMini,
} from '@nops/shared';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { get, qs } from './client';

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: ({ signal }) => get<Me>('/me', signal), staleTime: 60_000 });

export const useDashboard = () =>
  useQuery({
    queryKey: ['dashboard'],
    queryFn: ({ signal }) => get<Dashboard>('/dashboard', signal),
    refetchInterval: () => (visible() ? 30_000 : false),
  });

export type ItemFilters = Record<string, string | undefined>;

export const useItems = (filters: ItemFilters) =>
  useInfiniteQuery({
    queryKey: ['items', filters],
    queryFn: ({ pageParam, signal }) => get<ItemListPage>(`/items${qs({ ...filters, cursor: pageParam })}`, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    refetchInterval: () => (visible() ? 30_000 : false),
  });

export const useItem = (id: string | undefined) =>
  useQuery({
    queryKey: ['item', id],
    queryFn: ({ signal }) => get<ItemDetail>(`/items/${id}`, signal),
    enabled: !!id,
    refetchInterval: () => (visible() ? 15_000 : false),
    retry: (count, err: any) => !(err?.status >= 400 && err?.status < 500) && count < 2,
  });

export const useActivity = (itemId: string, filter: string) =>
  useInfiniteQuery({
    queryKey: ['activity', itemId, filter],
    queryFn: ({ pageParam, signal }) =>
      get<Page<ActivityEvent>>(`/items/${itemId}/activity${qs({ filter, cursor: pageParam, limit: 30 })}`, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: () => (visible() ? 15_000 : false),
  });

export const useProjects = () =>
  useQuery({ queryKey: ['projects'], queryFn: ({ signal }) => get<ProjectSummary[]>('/projects', signal), staleTime: 30_000 });

export const useProject = (id: string | undefined) =>
  useQuery({ queryKey: ['project', id], queryFn: ({ signal }) => get<ProjectDetail>(`/projects/${id}`, signal), enabled: !!id });

export const useMembers = (projectId: string | undefined) =>
  useQuery({
    queryKey: ['members', projectId],
    queryFn: ({ signal }) => get<{ user: WorkerMini; role: string; since: string }[]>(`/projects/${projectId}/members`, signal),
    enabled: !!projectId,
    staleTime: 30_000,
  });

export const useCanvas = (projectId: string) =>
  useQuery({
    queryKey: ['canvas', projectId],
    queryFn: ({ signal }) => get<CanvasData>(`/projects/${projectId}/canvas`, signal),
    staleTime: 5_000,
    // Changes arrive through the changes feed; a full reload once a minute refreshes the
    // project node's counts and refills stages whose top cards changed.
    refetchInterval: () => (visible() ? 60_000 : false),
  });

export const useUnreadCount = () =>
  useQuery({
    queryKey: ['unread'],
    queryFn: ({ signal }) => get<{ count: number }>('/notifications/unread-count', signal),
    refetchInterval: () => (visible() ? 15_000 : false),
  });

export const useNotifications = (unreadOnly: boolean) =>
  useInfiniteQuery({
    queryKey: ['notifications', unreadOnly],
    queryFn: ({ pageParam, signal }) =>
      get<Page<NotificationItem>>(`/notifications${qs({ unreadOnly: unreadOnly || undefined, cursor: pageParam, limit: 30 })}`, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: () => (visible() ? 15_000 : false),
  });

export const usePerson = (id: string) =>
  useQuery({ queryKey: ['person', id], queryFn: ({ signal }) => get<PersonProfile>(`/people/${id}`, signal) });
export const useRoleHistory = (id: string) =>
  useQuery({ queryKey: ['person', id, 'history'], queryFn: ({ signal }) => get<RoleHistoryRow[]>(`/people/${id}/history`, signal) });
export const usePersonStats = (id: string, period: string) =>
  useQuery({
    queryKey: ['person', id, 'stats', period],
    queryFn: ({ signal }) =>
      get<{ claimed: number; resolved: number; approved: number; notes: number }>(`/people/${id}/stats${qs({ period })}`, signal),
  });
export const usePersonActivity = (id: string, filter: string) =>
  useInfiniteQuery({
    queryKey: ['person', id, 'activity', filter],
    queryFn: ({ pageParam, signal }) =>
      get<Page<ActivityEvent>>(`/people/${id}/activity${qs({ filter, cursor: pageParam, limit: 30 })}`, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const useDirectory = () =>
  useQuery({
    queryKey: ['directory'],
    queryFn: ({ signal }) => get<{ id: string; fullName: string; designation: string }[]>('/directory', signal),
    staleTime: 60_000,
  });
export const useTeams = () =>
  useQuery({ queryKey: ['teams'], queryFn: ({ signal }) => get<{ id: string; name: string }[]>('/teams', signal) });
