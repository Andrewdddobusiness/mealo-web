/* eslint-disable react/no-unescaped-entities */
import React from "react";

export default function FAQ() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#fdf8f2]">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-10 top-10 h-64 w-64 rounded-full bg-primary/20 blur-pill" />
        <div className="absolute right-0 top-24 h-56 w-56 rounded-full bg-primary/15 blur-pill" />
      </div>
      <div className="relative mx-auto max-w-4xl space-y-6 px-6 py-16 sm:px-10">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold text-foreground">Frequently Asked Questions</h1>
          <p className="text-muted">Everything you need to know about Mealo.</p>
        </div>
        <div className="space-y-6 text-sm leading-relaxed text-muted">
          <section>
            <h2 className="text-lg font-semibold text-foreground">What is Mealo?</h2>
            <p className="mt-2">Mealo is a meal planning app designed for households. It helps you plan meals together, generate shopping lists automatically, and keep everyone in sync.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">Is Mealo free?</h2>
            <p className="mt-2">Mealo offers a free tier with essential features. We also have a premium subscription that unlocks advanced features like unlimited history, nutritional info, and more.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">How do I invite my family?</h2>
            <p className="mt-2">You can invite members to your household directly from the app settings. They'll receive a link to join your household and start planning with you.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">Does the shopping list sync?</h2>
            <p className="mt-2">Yes! Items added to the shopping list are instantly visible to all household members. When someone checks off an item, it updates for everyone.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">Can I use Mealo on Android?</h2>
            <p className="mt-2">Currently, Mealo is available on iOS. We are working hard to bring Mealo to Android devices soon.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-foreground">How do I contact support?</h2>
            <p className="mt-2">If you have any other questions or need assistance, please email us at <a href="mailto:support@mealo.app" className="text-primary hover:underline">support@mealo.app</a>.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
