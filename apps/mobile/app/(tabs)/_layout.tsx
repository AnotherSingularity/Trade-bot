import { useEffect, useState } from 'react';
import { Redirect, Tabs } from 'expo-router';
import { Text, View } from 'react-native';
import { getToken } from '../../lib/api';
import { theme } from '../../theme';

/** Simple icon — a label glyph keeps the bundle lean (no icon font dependency). */
function TabIcon({ glyph, color }: { glyph: string; color: string }) {
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color, fontSize: 18, fontFamily: theme.fonts.mono }}>{glyph}</Text>
    </View>
  );
}

export default function TabsLayout() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    getToken().then((t) => setAuthed(Boolean(t)));
  }, []);

  if (authed === null) return null; // still resolving token
  if (!authed) return <Redirect href="/login" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
        },
        tabBarActiveTintColor: theme.colors.green,
        tabBarInactiveTintColor: theme.colors.muted,
        tabBarLabelStyle: { fontFamily: theme.fonts.mono, fontSize: 10 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ color }) => <TabIcon glyph="◧" color={color} />,
        }}
      />
      <Tabs.Screen
        name="tokens"
        options={{
          title: 'Tokens',
          tabBarIcon: ({ color }) => <TabIcon glyph="≡" color={color} />,
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: 'History',
          tabBarIcon: ({ color }) => <TabIcon glyph="↻" color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <TabIcon glyph="⚙" color={color} />,
        }}
      />
    </Tabs>
  );
}
