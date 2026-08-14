import { CurrencyPipe, DatePipe, TitleCasePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { OfferingType } from '../../core/models/training.models';
import { AuthService } from '../../core/services/auth.service';
import { TrainingService } from '../../core/services/training.service';

type Filter = 'all' | OfferingType;

@Component({
  selector: 'app-home',
  imports: [CurrencyPipe, DatePipe, RouterLink, TitleCasePipe],
  templateUrl: './home.html',
})
export class Home {
  protected readonly training = inject(TrainingService);
  protected readonly auth = inject(AuthService);
  protected readonly filter = signal<Filter>('all');
  protected readonly filteredOfferings = computed(() => {
    const selected = this.filter();
    return this.training.offerings().filter((offering) => selected === 'all' || offering.type === selected);
  });

  protected selectFilter(filter: Filter): void {
    this.filter.set(filter);
  }
}
