export type AchievementCategory = 'planning' | 'creation' | 'social' | 'ai';

export type AchievementDefinition = {
  id: string;
  title: string;
  description: string;
  iconName: string;
  category: AchievementCategory;
  target: number;
};

export const ACHIEVEMENTS: AchievementDefinition[] = [
  {
    id: 'plan_first',
    title: 'First plan',
    description: 'Plan your first meal.',
    iconName: 'calendar',
    category: 'planning',
    target: 1,
  },
  {
    id: 'plan_streak_3',
    title: '3-day streak',
    description: 'Have meals planned for 3 days in a row.',
    iconName: 'trending-up',
    category: 'planning',
    target: 3,
  },
  {
    id: 'plan_week',
    title: 'Week planned',
    description: 'Plan meals for 7 days in a row.',
    iconName: 'check-circle',
    category: 'planning',
    target: 7,
  },
  {
    id: 'household_hero',
    title: 'Household hero',
    description: 'Have 5+ upcoming planned days.',
    iconName: 'users',
    category: 'planning',
    target: 5,
  },
  {
    id: 'meal_first',
    title: 'First recipe',
    description: 'Create your first custom meal.',
    iconName: 'book-open',
    category: 'creation',
    target: 1,
  },
  {
    id: 'meal_chef_10',
    title: 'Chef',
    description: 'Create 10 meals.',
    iconName: 'award',
    category: 'creation',
    target: 10,
  },
  {
    id: 'invite_first',
    title: 'First invite',
    description: 'Invite someone to your group.',
    iconName: 'user-plus',
    category: 'social',
    target: 1,
  },
  {
    id: 'ai_first_scan',
    title: 'First scan',
    description: 'Scan your first recipe.',
    iconName: 'camera',
    category: 'ai',
    target: 1,
  },
  {
    id: 'ai_power_user_20',
    title: 'Power user',
    description: 'Use AI 20 times.',
    iconName: 'zap',
    category: 'ai',
    target: 20,
  },
];

